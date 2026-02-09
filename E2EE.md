# End-to-End Encryption (E2EE) in The Hood

This document explains how end-to-end encryption works in this chat app, from the
cryptographic primitives all the way to the code. Written in plain language so anyone
can follow along.

---

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [What TweetNaCl Gives Us](#what-tweetnacl-gives-us)
3. [Key Storage (IndexedDB)](#key-storage-indexeddb)
4. [Room Lifecycle with E2EE](#room-lifecycle-with-e2ee)
5. [Sending a Message (Encryption)](#sending-a-message-encryption)
6. [Receiving a Message (Decryption)](#receiving-a-message-decryption)
7. [What the Server Sees](#what-the-server-sees)
8. [File-by-File Walkthrough](#file-by-file-walkthrough)
9. [Threat Model & Limitations](#threat-model--limitations)

---

## The Big Picture

```
Alice's Browser                    Server (Redis)                  Bob's Browser
──────────────                     ──────────────                  ─────────────
1. Generate keypair          -->   Stores Alice's PUBLIC key  <--  1. Generate keypair
   (private stays in browser)      Stores Bob's PUBLIC key         (private stays in browser)

2. Type "Hello Bob"
3. Encrypt with random key
4. Wrap that key for each
   participant (Alice + Bob)
5. Send ciphertext + wrapped keys  -->  Store blob as-is  -->  6. Receive ciphertext
                                                               7. Unwrap the key using
                                                                  Bob's PRIVATE key
                                                               8. Decrypt message
                                                               9. See "Hello Bob"
```

The server **never** sees "Hello Bob". It only stores and forwards encrypted blobs.

---

## What TweetNaCl Gives Us

[TweetNaCl](https://tweetnacl.cr.yp.to/) is a tiny, audited cryptography library. We
use two functions from it:

### `nacl.box` — Public-Key Encryption

Think of it as a **lockbox with two keys**.

- Every user has a **keypair**: a public key (the lock) and a secret key (the key that
  opens it).
- To send something to Bob, you use **Bob's public key** (his lock) and **your secret
  key** (to prove it's from you).
- Only Bob can open it because only he has his secret key.

Under the hood it uses:
- **X25519** — Elliptic-curve Diffie-Hellman to agree on a shared secret.
- **XSalsa20-Poly1305** — A fast stream cipher + authentication tag so nobody can
  tamper with the ciphertext.

```
nacl.box(message, nonce, recipientPublicKey, senderSecretKey) → ciphertext
nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey) → message
```

### `nacl.secretbox` — Symmetric Encryption

Think of it as a **padlock where both people share the same key**.

- You pick one random key, encrypt the data, done.
- Anyone with that key can decrypt.

Same cipher (XSalsa20-Poly1305), just without the key-exchange step.

```
nacl.secretbox(message, nonce, key) → ciphertext
nacl.secretbox.open(ciphertext, nonce, key) → message
```

### Nonces

Both functions require a **nonce** (number used once) — a 24-byte random value. It
ensures that even if you encrypt the same message twice, the ciphertext is different
each time. We generate a fresh random nonce for every operation.

---

## Key Storage (IndexedDB)

**File:** `src/lib/e2ee-key-storage.ts`

When a user first opens the app, we generate a keypair and store it in the browser's
**IndexedDB** (a built-in browser database). This is important because:

- The **private key never leaves the browser**. It's not sent to the server, not stored
  in cookies, not in localStorage (which is more accessible to scripts).
- IndexedDB persists across page reloads and browser restarts.
- If the user clears browser data, the keypair is gone and they can no longer decrypt
  old messages (which is fine — rooms self-destruct anyway).

```
IndexedDB: "the_hood_e2ee"
  └─ Object Store: "keypair"
       └─ Key: "identity"
            └─ Value: { publicKey: [...], secretKey: [...] }
```

The two functions are straightforward:
- `saveKeypair(keypair)` — Write the keypair to IndexedDB.
- `loadKeypair()` — Read it back. Returns `null` if none exists.

---

## Room Lifecycle with E2EE

Here's what happens step by step when two users chat:

### 1. Room Creation (no crypto yet)

Alice clicks "CREATE SECURE ROOM". The server creates a room ID and metadata in Redis.
No encryption keys are involved at this point.

### 2. Alice Joins the Room

```
Browser                              Server
───────                              ──────
1. Load/create keypair from IDB
2. GET /room/keys/me                 → Look up Alice's token → no participantId yet
3. POST /room/keys                   → Server generates a participantId for Alice
   { publicKey: "alice_pub_b64" }      Stores: keys:{roomId} = { participantId → publicKey }
                                       Stores: participantIdByToken:{roomId} = { token → participantId }
4. Receive { participantId: "abc" }
5. GET /room/keys                    → Returns [{ id: "abc", publicKey: "alice_pub_b64" }]
```

Alice now knows her own participantId and has the list of all public keys in the room.

### 3. Bob Joins the Room

Bob's browser does the exact same thing. Now the server has two entries in `keys:{roomId}`:

```
keys:{roomId} = {
  "abc": "alice_pub_b64",
  "def": "bob_pub_b64"
}
```

### 4. Alice Sends a Message

See the next section for the full encryption flow.

### 5. Room Destruction

When anyone clicks "DESTROY NOW" or the TTL expires:
- All Redis keys are deleted: `meta:`, `messages:`, `keys:`, `participantIdByToken:`.
- A `chat.destroy` event is broadcast so all clients redirect to the lobby.
- The ciphertext is gone. The private keys remain in each browser's IndexedDB but are
  useless without the ciphertext.

---

## Sending a Message (Encryption)

**File:** `src/lib/e2ee-crypto.ts` → `encryptForParticipants()`

When Alice types "Hello Bob" and hits Send, here's what happens:

### Step 1: Generate a Random Message Key

```ts
const messageKey = nacl.randomBytes(32)  // 32 random bytes
```

This is a one-time symmetric key. It will only be used for this single message.

### Step 2: Encrypt the Message with SecretBox

```ts
const contentNonce = nacl.randomBytes(24)
const encryptedContent = nacl.secretbox(
  new TextEncoder().encode("Hello Bob"),  // plaintext as bytes
  contentNonce,                            // unique nonce
  messageKey                               // the random key from step 1
)
```

Now `encryptedContent` is a blob of bytes that's meaningless without `messageKey`.

### Step 3: Wrap the Message Key for Each Participant

For Alice (so she can read her own messages):
```ts
const nonce1 = nacl.randomBytes(24)
const wrapped1 = nacl.box(messageKey, nonce1, alicePublicKey, aliceSecretKey)
```

For Bob:
```ts
const nonce2 = nacl.randomBytes(24)
const wrapped2 = nacl.box(messageKey, nonce2, bobPublicKey, aliceSecretKey)
```

Each wrapped key can only be opened by its intended recipient.

### Step 4: Send Everything to the Server

```json
{
  "sender": "anonymous-fox-a1b2c",
  "encryptedContent": "base64...",
  "contentNonce": "base64...",
  "senderPublicKey": "base64...",
  "keys": {
    "abc": { "nonce": "base64...", "ciphertext": "base64..." },
    "def": { "nonce": "base64...", "ciphertext": "base64..." }
  }
}
```

The server stores this blob in Redis and broadcasts a `chat.message` realtime event.

### Why Hybrid Encryption?

Why not just use `nacl.box` to encrypt the message directly for each recipient?

Because if there are N participants, you'd encrypt the full message N times. With
hybrid encryption, you encrypt the (potentially long) message **once** with secretbox,
then wrap the small 32-byte key N times with box. Much more efficient.

---

## Receiving a Message (Decryption)

**File:** `src/lib/e2ee-crypto.ts` → `decryptMessage()`

When Bob's browser receives the encrypted message:

### Step 1: Find Your Wrapped Key

```ts
const keyBlob = payload.keys["def"]  // Bob's participantId
// keyBlob = { nonce: "...", ciphertext: "..." }
```

If Bob's participantId isn't in `keys`, he wasn't a recipient (shouldn't happen in a
2-person room, but handled gracefully).

### Step 2: Unwrap the Message Key

```ts
const messageKey = nacl.box.open(
  keyBlob.ciphertext,      // the wrapped key
  keyBlob.nonce,           // the nonce used when wrapping
  payload.senderPublicKey, // Alice's public key
  bobSecretKey             // Bob's private key (from IndexedDB)
)
```

This performs the ECDH key exchange between Alice's public key and Bob's secret key to
derive the same shared secret Alice used, then decrypts the wrapped message key.

### Step 3: Decrypt the Message

```ts
const plaintext = nacl.secretbox.open(
  payload.encryptedContent,  // the encrypted message body
  payload.contentNonce,       // the nonce used when encrypting
  messageKey                  // recovered from step 2
)
// plaintext = "Hello Bob"
```

Bob now sees the original message. The server never had access to `messageKey` or the
plaintext.

---

## What the Server Sees

If you open the Redis database and look at a message, you'll see something like:

```json
{
  "id": "xK9mQ2...",
  "sender": "anonymous-fox-a1b2c",
  "timestamp": 1739180400000,
  "roomId": "abc123...",
  "encryptedContent": "7Gj8kL2mN4pQ6rS8tU0vW2xY4zA6bC8dE0fG...",
  "contentNonce": "aB3cD5eF7gH9iJ1kL3mN5oP7q...",
  "senderPublicKey": "R4sT6uV8wX0yZ2aB4cD6eF8gH0iJ...",
  "keys": {
    "abc": {
      "nonce": "2kL4mN6oP8qR0sT2uV4wX6yZ...",
      "ciphertext": "8aB0cD2eF4gH6iJ8kL0mN2oP4qR..."
    },
    "def": {
      "nonce": "6sT8uV0wX2yZ4aB6cD8eF0gH...",
      "ciphertext": "2iJ4kL6mN8oP0qR2sT4uV6wX..."
    }
  }
}
```

It's all random-looking base64 strings. The server can see:
- **Who** sent the message (the username, which is a random anonymous handle anyway)
- **When** it was sent (timestamp)
- **Which room** it belongs to
- **How many** participants received it (by counting entries in `keys`)

The server **cannot** see:
- The actual message text
- The symmetric message key
- Anyone's private key

---

## File-by-File Walkthrough

### `src/lib/e2ee-key-storage.ts`

| Function | What it does |
|---|---|
| `openDb()` | Opens (or creates) the IndexedDB database `the_hood_e2ee` |
| `saveKeypair(keypair)` | Writes `{ publicKey, secretKey }` to IndexedDB |
| `loadKeypair()` | Reads the keypair back, returns `null` if not found |

### `src/lib/e2ee-crypto.ts`

| Function | What it does |
|---|---|
| `generateKeypair()` | Calls `nacl.box.keyPair()` to create a new X25519 keypair |
| `getOrCreateKeypair()` | Loads from IndexedDB or generates + saves a new one |
| `publicKeyToBase64()` | Converts a `Uint8Array` public key to a base64 string |
| `base64ToPublicKey()` | Converts a base64 string back to `Uint8Array` |
| `encryptForParticipants()` | Hybrid encryption: secretbox for message, box for each recipient's key |
| `decryptMessage()` | Reverse of above: box.open for key, secretbox.open for message |

### `src/app/api/[[...slugs]]/route.ts` — Server API

| Endpoint | What it does |
|---|---|
| `POST /room/keys` | Register a public key for the current user in this room. Returns a `participantId`. Idempotent — re-registering updates the key. |
| `GET /room/keys/me` | Returns the current user's `participantId` (looked up by auth token). |
| `GET /room/keys` | Returns all `{ id, publicKey }` pairs for the room. Used by the sender to encrypt for everyone. |
| `POST /messages` | Accepts an encrypted payload (no plaintext). Stores in Redis, broadcasts via realtime. |
| `GET /messages` | Returns the list of encrypted messages. No decryption happens server-side. |
| `DELETE /room` | Destroys the room including all keys and messages from Redis. |

### `src/lib/realtime.ts` — Message Schema

Defines the Zod schema for messages. The `message` object now has `encryptedContent`,
`contentNonce`, `senderPublicKey`, and `keys` instead of a `text` field. The server
validates the shape but can't read the content.

### `src/app/room/[roomId]/page.tsx` — Room UI

The room page handles the full E2EE lifecycle:

1. **On mount**: Load or create keypair from IndexedDB.
2. **Key registration**: Check if we already have a `participantId` (GET `/keys/me`).
   If not, register our public key (POST `/keys`).
3. **Fetch participants**: GET `/keys` to get everyone's public keys.
4. **Send**: Encrypt with `encryptForParticipants()`, POST the ciphertext.
5. **Receive**: On each message from realtime, refetch messages list, then
   `decryptMessage()` each one for display.
6. **UI indicators**: Shows "E2EE" badge when encryption is ready, "Setting up
   encryption..." while initializing, "Waiting for other participant..." if no one
   else has joined yet.

### `src/proxy.ts` — Middleware

Handles room access control. When a user visits `/room/{id}`:
- Checks if the room exists in Redis.
- Assigns an `x-auth-token` cookie (max 2 users per room).
- This token is later used by the auth middleware to identify the user and by the
  key-registration endpoints to map token → participantId.

### `src/app/api/[[...slugs]]/auth.ts` — Auth Middleware

Validates the `x-auth-token` cookie on every API call. Ensures the token is in the
room's `connected` list. Provides `{ roomId, token, connected }` to downstream
handlers.

---

## Threat Model & Limitations

### What E2EE Protects Against

- **Server compromise**: Even if someone gains access to Redis or the server code,
  they only see ciphertext. They cannot read messages without a participant's private
  key.
- **Network eavesdropping**: Even without HTTPS (which you should still use!), the
  message content is encrypted.
- **Database leaks**: If the Redis data is dumped, messages are unintelligible.

### What E2EE Does NOT Protect Against

- **Metadata**: The server knows who is talking, when, and how often. It just doesn't
  know what they're saying.
- **Compromised browser**: If an attacker has access to a user's browser (e.g. via
  XSS or malware), they can read the private key from IndexedDB.
- **Key verification**: There's no mechanism to verify that the public key registered
  on the server actually belongs to the intended person (no "safety numbers" like
  Signal). A compromised server could theoretically substitute a public key.
- **Forward secrecy**: We use a long-lived identity keypair. If a private key is
  compromised in the future, past messages (if the ciphertext was saved) could be
  decrypted. Signal solves this with the Double Ratchet algorithm, which is beyond our
  scope here.
- **Browser data cleared**: If a user clears IndexedDB, their private key is gone and
  they can no longer decrypt any messages they received (though rooms self-destruct
  anyway so this is a minor issue).

### Why TweetNaCl?

- **Audited and stable**: The cryptographic primitives are well-studied
  (Curve25519, XSalsa20, Poly1305).
- **Zero dependencies**: The entire library is ~1500 lines of JavaScript.
- **No configuration**: You can't accidentally pick a weak cipher or mode. The API is
  deliberately simple to prevent misuse.
- **Battle-tested**: Used by many projects including the original NaCl by
  Daniel J. Bernstein.

---

*This document describes the E2EE implementation as of the `feat/encrypt` branch.*
