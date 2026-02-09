import { redis } from "@/lib/redis"
import { Elysia } from "elysia"
import { nanoid } from "nanoid"
import { authMiddleware } from "./auth"
import { z } from "zod"
import { Message, realtime } from "@/lib/realtime"

const ROOM_TTL_SECONDS =60 * 10

const rooms = new Elysia({ prefix: "/room" })
  .post("/create", async () => {
    const roomId = nanoid()

    await redis.hset(`meta:${roomId}`, {
      connected: [],
      createdAt: Date.now(),
    })

    await redis.expire(`meta:${roomId}`, ROOM_TTL_SECONDS)

    return { roomId }
  })
  .use(authMiddleware)
  .get(
    "/ttl",
    async ({ auth }) => {
      const ttl = await redis.ttl(`meta:${auth.roomId}`)
      return { ttl: ttl > 0 ? ttl : 0 }
    },
    { query: z.object({ roomId: z.string() }) }
  )
  .delete(
    "/",
    async ({ auth }) => {
      await realtime.channel(auth.roomId).emit("chat.destroy", { isDestroyed: true })

      await Promise.all([
        redis.del(auth.roomId),
        redis.del(`meta:${auth.roomId}`),
        redis.del(`messages:${auth.roomId}`),
        redis.del(`keys:${auth.roomId}`),
        redis.del(`participantIdByToken:${auth.roomId}`),
      ])
    },
    { query: z.object({ roomId: z.string() }) }
  )
  .post(
    "/keys",
    async ({ body, auth }) => {
      const roomExists = await redis.exists(`meta:${auth.roomId}`)
      if (!roomExists) throw new Error("Room does not exist")

      let participantId = await redis.hget<string>(`participantIdByToken:${auth.roomId}`, auth.token)
      if (participantId) {
        await redis.hset(`keys:${auth.roomId}`, { [participantId]: body.publicKey })
      } else {
        participantId = nanoid()
        await redis.hset(`keys:${auth.roomId}`, { [participantId]: body.publicKey })
        await redis.hset(`participantIdByToken:${auth.roomId}`, { [auth.token]: participantId })
      }

      const remaining = await redis.ttl(`meta:${auth.roomId}`)
      await redis.expire(`keys:${auth.roomId}`, remaining)
      await redis.expire(`participantIdByToken:${auth.roomId}`, remaining)

      return { participantId }
    },
    {
      query: z.object({ roomId: z.string() }),
      body: z.object({ publicKey: z.string().min(1).max(500) }),
    }
  )
  .get(
    "/keys/me",
    async ({ auth }) => {
      const participantId = await redis.hget<string>(`participantIdByToken:${auth.roomId}`, auth.token)
      if (!participantId) return { participantId: null as string | null }
      return { participantId }
    },
    { query: z.object({ roomId: z.string() }) }
  )
  .get(
    "/keys",
    async ({ auth }) => {
      const keys = await redis.hgetall<Record<string, string>>(`keys:${auth.roomId}`)
      const participants = Object.entries(keys ?? {}).map(([id, publicKey]) => ({ id, publicKey }))
      return { participants }
    },
    { query: z.object({ roomId: z.string() }) }
  )

const encryptedMessageBody = z.object({
  sender: z.string().max(100),
  encryptedContent: z.string(),
  contentNonce: z.string(),
  senderPublicKey: z.string(),
  keys: z.record(
    z.string(),
    z.object({ nonce: z.string(), ciphertext: z.string() })
  ),
})

const messages = new Elysia({ prefix: "/messages" })
  .use(authMiddleware)
  .post(
    "/",
    async ({ body, auth }) => {
      const { roomId } = auth

      const roomExists = await redis.exists(`meta:${roomId}`)
      if (!roomExists) throw new Error("Room does not exist")

      const message: Message = {
        id: nanoid(),
        sender: body.sender,
        timestamp: Date.now(),
        roomId,
        encryptedContent: body.encryptedContent,
        contentNonce: body.contentNonce,
        senderPublicKey: body.senderPublicKey,
        keys: body.keys,
      }

      await redis.rpush(`messages:${roomId}`, { ...message, token: auth.token })
      await realtime.channel(roomId).emit("chat.message", message)

      const remaining = await redis.ttl(`meta:${roomId}`)
      await redis.expire(`messages:${roomId}`, remaining)
      await redis.expire(roomId, remaining)
    },
    {
      query: z.object({ roomId: z.string() }),
      body: encryptedMessageBody,
    }
  )
  .get(
    "/",
    async ({ auth }) => {
      const list = await redis.lrange<Message & { token?: string }>(`messages:${auth.roomId}`, 0, -1)

      return {
        messages: list.map((m) => {
          const { token: _t, ...rest } = m
          return rest
        }),
      }
    },
    { query: z.object({ roomId: z.string() }) }
  )

const app = new Elysia({ prefix: "/api" })
    .onBeforeHandle(({ request, set }) => {
        const origin = request.headers.get("origin")
        if (origin) {
            set.headers["Access-Control-Allow-Origin"] = origin
            set.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
            set.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
            set.headers["Access-Control-Allow-Credentials"] = "true"
        }
    })
    .options("*", () => {
        return new Response(null, { status: 204 })
    })
    .use(rooms)
    .use(messages)

export const GET = app.fetch
export const POST = app.fetch
export const DELETE = app.fetch
export const OPTIONS = app.fetch

export type App = typeof app