import { safeStorage } from 'electron'
import { existsSync } from 'fs'
import { readFileSync, writeFileSync, rmSync } from 'fs'
import path from 'path'
import { dataDir } from '../utils/dirs'

// Cabinet session: the tokens the client gets after signing in, whichever way
// it signed in — e-mail and Telegram end in the identical response.
//
// It is kept, and not re-requested, on purpose. The cabinet counts SUCCESSFUL
// e-mail logins against the same limit as failed ones (10 per 15 minutes per
// address), so a client that signs in "just in case" locks the person out with
// a correct password.
export interface CabinetSession {
  accessToken: string
  refreshToken: string
  // Absolute moment, computed from expires_in when the tokens arrived.
  expiresAt: number
}

const SESSION_FILE = 'cabinet-session'
const ENCRYPTED_PREFIX = 'enc:'

let session: CabinetSession | null = null
let loaded = false

function filePath(): string {
  return path.join(dataDir(), SESSION_FILE)
}

// Deliberately stricter than utils/encrypt: that helper falls back to writing
// plain text when the keychain is unavailable. A refresh token is a credential
// and must not be left readable on disk — when there is no keychain the
// session simply lives for this run only.
function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (!existsSync(filePath())) return
    const raw = readFileSync(filePath(), 'utf-8')
    if (!raw.startsWith(ENCRYPTED_PREFIX)) return
    if (!safeStorage.isEncryptionAvailable()) return
    const json = safeStorage.decryptString(Buffer.from(raw.slice(ENCRYPTED_PREFIX.length), 'base64'))
    const parsed = JSON.parse(json) as CabinetSession
    if (parsed?.accessToken && parsed?.refreshToken) {
      session = parsed
    }
  } catch {
    // A session we cannot read is a session we do not have.
    session = null
  }
}

export function getCabinetSession(): CabinetSession | null {
  load()
  return session
}

export function setCabinetSession(next: CabinetSession): void {
  loaded = true
  session = next
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Nothing written: better a session that ends with the app than a
      // credential sitting in a readable file.
      return
    }
    const blob = safeStorage.encryptString(JSON.stringify(next)).toString('base64')
    writeFileSync(filePath(), ENCRYPTED_PREFIX + blob, { mode: 0o600 })
  } catch {
    // keeping it in memory is still useful for this run
  }
}

export function clearCabinetSession(): void {
  loaded = true
  session = null
  try {
    if (existsSync(filePath())) rmSync(filePath())
  } catch {
    // nothing else to do
  }
}

export function isSessionFresh(s: CabinetSession): boolean {
  // A minute of slack so a request started now does not race the expiry.
  return s.expiresAt - Date.now() > 60_000
}
