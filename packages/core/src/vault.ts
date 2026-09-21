/**
 * Encrypted project vault — "simpan konfigurasi (config, mcp, provider,
 * apikey, memory) di proyek kalo user mau, tapi dienkripsi".
 *
 * The vault is a small AES-256-GCM sealed JSON file that lives INSIDE the
 * project (`.tagent-sync/vault.json` — committed & synced like any other
 * file), while `.tagent/` (the plaintext local config) stays gitignored.
 *
 * Key model:
 *   passphrase --scrypt(salt)--> 32-byte key --AES-256-GCM--> vault file
 * The passphrase itself never leaves the device: it lives in the local
 * credential store (~/.tagent/credentials.json, 0600) under `vault`. Any
 * device that knows the passphrase can decrypt the synced settings — set
 * it once per device via /repo (or `tagent projects` → edit).
 */
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto'
import { getCredential, setCredential, deleteCredential } from './credentials'

/** Envelope on disk — everything base64, nothing readable. */
export interface VaultFile {
  v: 1
  kdf: 'scrypt'
  /** 16 random bytes — per-vault, rotatated with the passphrase */
  salt: string
  /** 12-byte GCM nonce */
  iv: string
  /** 16-byte GCM auth tag — wrong passphrase fails here, cleanly */
  tag: string
  /** ciphertext (JSON payload inside) */
  ct: string
}

export const VAULT_CREDENTIAL = 'vault'

/** scrypt cost — strong for a 32-byte key, still ~100ms on a laptop. */
const SCRYPT_N = 1 << 15 // 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // 64MB ceiling — 128*N*r (=32MB) plus overhead trips Bun/OpenSSL's
  // default 32MB maxmem otherwise
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 })
}

/** Seal any JSON-serializable payload. A fresh salt+iv every call — encrypting
 *  the same payload twice yields different files (no equality oracle). */
export function encryptVaultJSON(data: unknown, passphrase: string): VaultFile {
  if (!passphrase) throw new Error('vault: passphrase is required')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  return {
    v: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

/** Open a vault. Throws a friendly Error on wrong passphrase / tampering. */
export function decryptVaultJSON(file: VaultFile, passphrase: string): unknown {
  if (!passphrase) throw new Error('vault: passphrase is required')
  try {
    const salt = Buffer.from(file.salt, 'base64')
    const iv = Buffer.from(file.iv, 'base64')
    const tag = Buffer.from(file.tag, 'base64')
    const key = deriveKey(passphrase, salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(Buffer.from(file.ct, 'base64')), decipher.final()])
    return JSON.parse(pt.toString('utf8'))
  } catch (err) {
    const msg = String((err as Error)?.message ?? '')
    if (/[Uu]nsupported state|[Ii]nvalid (length|auth)|[Ff]inal|authenticate/.test(msg) || msg === '') {
      throw new Error('vault: wrong passphrase (or the file was corrupted)')
    }
    throw new Error(`vault: could not decrypt (${msg})`)
  }
}

/** `parseVaultFile` — validate an unknown JSON blob into a VaultFile. */
export function parseVaultFile(raw: unknown): VaultFile | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (
    v.v === 1 && v.kdf === 'scrypt' &&
    typeof v.salt === 'string' && typeof v.iv === 'string' &&
    typeof v.tag === 'string' && typeof v.ct === 'string'
  ) {
    return v as unknown as VaultFile
  }
  return null
}

/* --------------------------- passphrase store --------------------------- */

/** The passphrase saved on THIS device (credential store, 0600). */
export function getVaultPassphrase(): string {
  return getCredential(VAULT_CREDENTIAL) ?? ''
}

/** Save / rotate this device's passphrase. Empty clears it. */
export function setVaultPassphrase(passphrase: string): void {
  if (!passphrase) deleteCredential(VAULT_CREDENTIAL)
  else setCredential(VAULT_CREDENTIAL, passphrase)
}

/** Human-typable strong passphrase — `tagent-xxxxx-xxxxx-xxxxx-xxxxx`
 *  (Crockford-ish alphabet, no lookalikes). For the "user picked nothing"
 *  case so encryption is never silently skipped. */
export function generatePassphrase(): string {
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
  const group = (): string =>
    Array.from(randomBytes(5))
      .map((b) => ALPHABET[b % ALPHABET.length])
      .join('')
  return ['tagent', group(), group(), group(), group()].join('-')
}

/** Constant-time compare for user-supplied passphrases (UX echo checks). */
export function passphraseEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
