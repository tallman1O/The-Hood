/**
 * Store and retrieve the user's E2EE keypair in IndexedDB.
 * Private key never leaves the browser.
 */

const DB_NAME = "the_hood_e2ee"
const STORE_NAME = "keypair"
const KEYPAIR_KEY = "identity"

export interface StoredKeypair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
  })
}

function getStore(db: IDBDatabase, mode: IDBTransactionMode = "readonly") {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
}

export async function saveKeypair(keypair: StoredKeypair): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const store = getStore(db, "readwrite")
    const payload = {
      publicKey: Array.from(keypair.publicKey),
      secretKey: Array.from(keypair.secretKey),
    }
    const req = store.put(payload, KEYPAIR_KEY)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve()
  })
}

export async function loadKeypair(): Promise<StoredKeypair | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const store = getStore(db)
    const req = store.get(KEYPAIR_KEY)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const row = req.result as { publicKey: number[]; secretKey: number[] } | undefined
      if (!row) {
        resolve(null)
        return
      }
      resolve({
        publicKey: new Uint8Array(row.publicKey),
        secretKey: new Uint8Array(row.secretKey),
      })
    }
  })
}
