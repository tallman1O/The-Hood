"use client"

import { useUsername } from "@/hooks/use-username"
import { client } from "@/lib/client"
import {
  decryptMessage,
  encryptForParticipants,
  getOrCreateKeypair,
  publicKeyToBase64,
  type ParticipantKeys,
} from "@/lib/e2ee-crypto"
import type { StoredKeypair } from "@/lib/e2ee-key-storage"
import { useRealtime } from "@/lib/realtime-client"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import { useParams, useRouter } from "next/navigation"
import { startTransition, useEffect, useRef, useState } from "react"

function formatTimeRemaining(seconds: number) {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

/** Encrypted message shape from API (server never sees plaintext). */
interface EncryptedMessage {
  id: string
  sender: string
  timestamp: number
  roomId: string
  encryptedContent: string
  contentNonce: string
  senderPublicKey: string
  keys: Record<string, { nonce: string; ciphertext: string }>
}

const Page = () => {
  const params = useParams()
  const roomId = params.roomId as string

  const router = useRouter()

  const { username } = useUsername()
  const [input, setInput] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const [copyStatus, setCopyStatus] = useState("COPY")
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null)
  const lastSyncedTtlRef = useRef<number | undefined>(undefined)

  const [keypair, setKeypair] = useState<StoredKeypair | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const kp = await getOrCreateKeypair()
      if (cancelled) return
      setKeypair(kp)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const { data: myIdData } = useQuery({
    queryKey: ["room-keys-me", roomId],
    queryFn: async () => {
      const res = await client.room.keys.me.get({ query: { roomId } })
      return res.data
    },
    enabled: !!roomId && !!keypair,
  })

  const registerKey = useMutation({
    mutationFn: async () => {
      if (!keypair) throw new Error("No keypair")
      const res = await client.room.keys.post(
        { publicKey: publicKeyToBase64(keypair.publicKey) },
        { query: { roomId } }
      )
      if (res.status !== 200 || !res.data?.participantId) throw new Error("Failed to register key")
      return res.data.participantId
    },
  })

  const myParticipantId = myIdData?.participantId ?? registerKey.data ?? null

  useEffect(() => {
    if (!keypair || myParticipantId != null || registerKey.isPending) return
    if (myIdData?.participantId === null) {
      registerKey.mutate()
    }
  }, [keypair, myParticipantId, myIdData?.participantId, registerKey.isPending])
  
  const { data: ttlData } = useQuery({
    queryKey: ["ttl", roomId],
    queryFn: async () => {
      const res = await client.room.ttl.get({ query: { roomId } })
      return res.data
    },
  })

  useEffect(() => {
    if (ttlData?.ttl !== undefined && lastSyncedTtlRef.current !== ttlData.ttl) {
      lastSyncedTtlRef.current = ttlData.ttl
      startTransition(() => {
        setTimeRemaining(ttlData.ttl)
      })
    }
  }, [ttlData])

  useEffect(() => {
    if (timeRemaining === null || timeRemaining < 0) return

    if (timeRemaining === 0) {
      router.push("/?destroyed=true")
      return
    }

    const interval = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [timeRemaining, router])

  const { data: participantsData } = useQuery({
    queryKey: ["room-keys", roomId],
    queryFn: async () => {
      const res = await client.room.keys.get({ query: { roomId } })
      return res.data
    },
    enabled: !!roomId && !!myParticipantId,
  })

  const participants: ParticipantKeys[] = participantsData?.participants ?? []
  const queryClient = useQueryClient()

  const { data: messagesData, refetch } = useQuery({
    queryKey: ["messages", roomId],
    queryFn: async () => {
      const res = await client.messages.get({ query: { roomId } })
      return res.data
    },
    enabled: !!roomId,
  })

  const rawMessages: EncryptedMessage[] = messagesData?.messages ?? []

  const { mutate: sendMessage, isPending } = useMutation({
    mutationFn: async ({ text }: { text: string }) => {
      if (!keypair || !myParticipantId) throw new Error("Encryption not ready")
      const { participants: latest } = await queryClient.fetchQuery({
        queryKey: ["room-keys", roomId],
        queryFn: async () => {
          const res = await client.room.keys.get({ query: { roomId } })
          return res.data ?? { participants: [] }
        },
      })
      if (latest.length === 0) throw new Error("No participants")
      const payload = encryptForParticipants(text, keypair, latest)
      await client.messages.post(
        {
          sender: username,
          encryptedContent: payload.encryptedContent,
          contentNonce: payload.contentNonce,
          senderPublicKey: payload.senderPublicKey,
          keys: payload.keys,
        },
        { query: { roomId } }
      )
      setInput("")
    },
  })

  useRealtime({
    channels: [roomId],
    events: ["chat.message", "chat.destroy"],
    onData: ({ event }) => {
      if (event === "chat.message") {
        refetch()
        queryClient.invalidateQueries({ queryKey: ["room-keys", roomId] })
      }

      if (event === "chat.destroy") {
        router.push("/?destroyed=true")
      }
    },
  })

  const { mutate: destroyRoom } = useMutation({
    mutationFn: async () => {
      await client.room.delete(null, { query: { roomId } })
    },
  })

  const copyLink = () => {
    const url = window.location.href
    navigator.clipboard.writeText(url)
    setCopyStatus("COPIED! 📋")
    setTimeout(() => setCopyStatus("COPY"), 2000)
  }

  const e2eeReady = !!keypair && !!myParticipantId
  const canSend = e2eeReady && participants.length > 0

  function decryptMessageText(msg: EncryptedMessage): string {
    if (!keypair || !myParticipantId) return "…"
    const text = decryptMessage(
      {
        encryptedContent: msg.encryptedContent,
        contentNonce: msg.contentNonce,
        senderPublicKey: msg.senderPublicKey,
        keys: msg.keys,
      },
      myParticipantId,
      keypair
    )
    return text ?? "🔒 Unable to decrypt"
  }

  return (
    <main className="flex flex-col h-screen max-h-screen overflow-hidden bg-black">
      <header className="border-b border-zinc-800 p-4 flex items-center justify-between bg-zinc-900/30">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="text-xs text-zinc-500 uppercase">Room ID</span>
            <div className="flex items-center gap-2">
              <span className="font-bold text-green-500 truncate">{roomId.slice(0, 10) + "..."}</span>
              <button
                onClick={copyLink}
                className="text-[10px] bg-zinc-800 hover:bg-zinc-700 px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                {copyStatus}
              </button>
            </div>
          </div>

          <div className="h-8 w-px bg-zinc-800" />

          <div className="flex flex-col">
            <span className="text-xs text-zinc-500 uppercase">Self-Destruct</span>
            <span
              className={`text-sm font-bold flex items-center gap-2 ${
                timeRemaining !== null && timeRemaining < 60
                  ? "text-red-500"
                  : "text-amber-500"
              }`}
            >
              {timeRemaining !== null ? formatTimeRemaining(timeRemaining) : "--:--"}
            </span>
          </div>

          {e2eeReady && (
            <>
              <div className="h-8 w-px bg-zinc-800" />
              <span className="text-[10px] text-green-600 font-mono" title="End-to-end encrypted">
                E2EE
              </span>
            </>
          )}
        </div>

        <button
          onClick={() => destroyRoom()}
          className="text-xs bg-zinc-800 hover:bg-red-600 px-3 py-1.5 rounded text-zinc-400 hover:text-white font-bold transition-all group flex items-center gap-2 disabled:opacity-50"
        >
          <span className="group-hover:animate-pulse">💣</span>
          DESTROY NOW
        </button>
      </header>

      {/* MESSAGES */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
        {!e2eeReady && (
          <div className="flex items-center justify-center py-4">
            <p className="text-zinc-500 text-sm font-mono">Setting up encryption…</p>
          </div>
        )}

        {e2eeReady && rawMessages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-zinc-600 text-sm font-mono">
              No messages yet, start the conversation.
            </p>
          </div>
        )}

        {e2eeReady &&
          rawMessages.map((msg) => (
            <div key={msg.id} className="flex flex-col items-start">
              <div className="max-w-[80%] group">
                <div className="flex items-baseline gap-3 mb-1">
                  <span
                    className={`text-xs font-bold ${
                      msg.sender === username ? "text-green-500" : "text-blue-500"
                    }`}
                  >
                    {msg.sender === username ? "YOU" : msg.sender}
                  </span>

                  <span className="text-[10px] text-zinc-600">
                    {format(msg.timestamp, "HH:mm")}
                  </span>
                </div>

                <p className="text-sm text-zinc-300 leading-relaxed break-all">
                  {decryptMessageText(msg)}
                </p>
              </div>
            </div>
          ))}
      </div>

      <div className="p-4 border-t border-zinc-800 bg-zinc-900/30">
        <div className="flex gap-4">
          <div className="flex-1 relative group">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-green-500 animate-pulse">
              {">"}
            </span>
            <input
              autoFocus
              type="text"
              value={input}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim() && canSend) {
                  sendMessage({ text: input })
                  inputRef.current?.focus()
                }
              }}
              placeholder={
                canSend
                  ? "Type message..."
                  : !e2eeReady
                    ? "Setting up encryption..."
                    : "Waiting for other participant..."
              }
              onChange={(e) => setInput(e.target.value)}
              className="w-full bg-black border border-zinc-800 focus:border-zinc-700 focus:outline-none transition-colors text-zinc-100 placeholder:text-zinc-700 py-3 pl-8 pr-4 text-sm"
            />
          </div>

          <button
            onClick={() => {
              sendMessage({ text: input })
              inputRef.current?.focus()
            }}
            disabled={!input.trim() || isPending || !canSend}
            className="bg-zinc-800 text-zinc-400 px-6 text-sm font-bold hover:text-zinc-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            SEND
          </button>
        </div>
      </div>
    </main>
  )
}

export default Page
