/**
 * E2EE using tweetnacl: ECDH (box) for key encapsulation, secretbox for message.
 * Server never sees plaintext.
 */

import nacl from "tweetnacl"
import {
  loadKeypair,
  saveKeypair,
  type StoredKeypair,
} from "./e2ee-key-storage"

const NONCE_LENGTH = 24
const SYMMETRIC_KEY_LENGTH = 32

function b64Encode(u: Uint8Array): string {
  return btoa(String.fromCharCode(...u))
}

function b64Decode(s: string): Uint8Array {
  return new Uint8Array(
    atob(s)
      .split("")
      .map((c) => c.charCodeAt(0))
  )
}

/** Generate a new identity keypair (X25519 + XSalsa20-Poly1305 via nacl.box). */
export function generateKeypair(): StoredKeypair {
  const keyPair = nacl.box.keyPair()
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
  }
}

/** Get existing keypair from IndexedDB or create, save, and return a new one. */
export async function getOrCreateKeypair(): Promise<StoredKeypair> {
  const existing = await loadKeypair()
  if (existing) return existing
  const keypair = generateKeypair()
  await saveKeypair(keypair)
  return keypair
}

/** Public key as base64 (for sending to server / identifying participants). */
export function publicKeyToBase64(publicKey: Uint8Array): string {
  return b64Encode(publicKey)
}

export function base64ToPublicKey(b64: string): Uint8Array {
  return b64Decode(b64)
}

export interface ParticipantKeys {
  id: string
  publicKey: string
}

export interface EncryptedPayload {
  encryptedContent: string
  contentNonce: string
  senderPublicKey: string
  keys: Record<string, { nonce: string; ciphertext: string }>
}

/**
 * Encrypt a plaintext for a set of participants (including self).
 * Uses a random symmetric key, encrypts the message with secretbox, then
 * encrypts that key for each participant with nacl.box.
 */
export function encryptForParticipants(
  plaintext: string,
  senderKeypair: StoredKeypair,
  participants: ParticipantKeys[]
): EncryptedPayload {
  const messageKey = nacl.randomBytes(SYMMETRIC_KEY_LENGTH)
  const contentNonce = nacl.randomBytes(NONCE_LENGTH)
  const encryptedContent = nacl.secretbox(
    new TextEncoder().encode(plaintext),
    contentNonce,
    messageKey
  )

  const keys: Record<string, { nonce: string; ciphertext: string }> = {}
  for (const p of participants) {
    const recipientPub = base64ToPublicKey(p.publicKey)
    const nonce = nacl.randomBytes(NONCE_LENGTH)
    const ciphertext = nacl.box(messageKey, nonce, recipientPub, senderKeypair.secretKey)
    keys[p.id] = { nonce: b64Encode(nonce), ciphertext: b64Encode(ciphertext) }
  }

  return {
    encryptedContent: b64Encode(encryptedContent),
    contentNonce: b64Encode(contentNonce),
    senderPublicKey: publicKeyToBase64(senderKeypair.publicKey),
    keys,
  }
}

/**
 * Decrypt a message using our keypair and our participant id.
 * Returns null if we're not a recipient or decryption fails.
 */
export function decryptMessage(
  payload: EncryptedPayload,
  myParticipantId: string,
  myKeypair: StoredKeypair
): string | null {
  const keyBlob = payload.keys[myParticipantId]
  if (!keyBlob) return null

  const senderPub = base64ToPublicKey(payload.senderPublicKey)
  const nonce = b64Decode(keyBlob.nonce)
  const ciphertext = b64Decode(keyBlob.ciphertext)
  const messageKey = nacl.box.open(ciphertext, nonce, senderPub, myKeypair.secretKey)
  if (!messageKey) return null

  const encryptedContent = b64Decode(payload.encryptedContent)
  const contentNonce = b64Decode(payload.contentNonce)
  const plainBytes = nacl.secretbox.open(encryptedContent, contentNonce, messageKey)
  if (!plainBytes) return null

  return new TextDecoder().decode(plainBytes)
}
