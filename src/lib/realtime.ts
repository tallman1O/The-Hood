import { redis } from "@/lib/redis"
import { InferRealtimeEvents, Realtime } from "@upstash/realtime"
import z from "zod"

const encryptedKeyBlob = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
})

const message = z.object({
  id: z.string(),
  sender: z.string(),
  timestamp: z.number(),
  roomId: z.string(),
  token: z.string().optional(),
  // E2EE: server never sees plaintext
  encryptedContent: z.string(),
  contentNonce: z.string(),
  senderPublicKey: z.string(),
  keys: z.record(z.string(), encryptedKeyBlob),
})

const schema = {
  chat: {
    message,
    destroy: z.object({
      isDestroyed: z.literal(true),
    }),
  },
}

export const realtime = new Realtime({ schema, redis })
export type RealtimeEvents = InferRealtimeEvents<typeof realtime>
export type Message = z.infer<typeof message>