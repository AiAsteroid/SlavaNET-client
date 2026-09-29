import { shell } from 'electron'
import axios from 'axios'
import { t } from '../utils/i18n'

// One-click subscription flow, cabinet side.
//
//   1. POST /cabinet/auth/deeplink/request  -> { token, bot_username, expires_in }
//   2. open https://t.me/<bot_username>?start=webauth_<token>
//   3. poll POST /cabinet/auth/deeplink/poll { token } until it answers 200
//   4. GET /cabinet/subscription with the bearer token -> subscription_url
//
// No new server code: every endpoint already exists and is used by the web
// cabinet. Confirming inside Telegram is also what makes the flow safe — the
// person approves in the messenger they are already signed into, so the client
// never has to prove that a callback really came from us.
//
// Caddy strips the /api prefix before the app sees it, and the cabinet router
// is mounted with redirect_slashes=False: a trailing slash returns 404 rather
// than redirecting. Paths below are written exactly as they must be sent.
// SLAVANET_CABINET_BASE points the client at a stub or a staging cabinet; it
// exists so the whole flow, including every failure branch, can be exercised
// without touching production.
const CABINET_BASE = process.env.SLAVANET_CABINET_BASE || 'https://web.slavanet.org/api'
const PATH_DEEPLINK_REQUEST = '/cabinet/auth/deeplink/request'
const PATH_DEEPLINK_POLL = '/cabinet/auth/deeplink/poll'
const PATH_SUBSCRIPTION = '/cabinet/subscription'

// The web cabinet polls at the same interval. One second would sit exactly on
// the 60-per-minute limit, so two clients behind one NAT would start getting
// 429 immediately.
const POLL_INTERVAL = 2500
const REQUEST_TIMEOUT = 15000
// Fallback only: the real deadline comes from expires_in in the first response.
const DEFAULT_TOKEN_TTL = 300

export interface ConnectProgress {
  status: ConnectStatus
  message?: string
  link?: string
}

type Report = (progress: ConnectProgress) => void

let cancelled = false
let running = false
// The card lives on two screens now, so leaving and coming back mid-flow is
// normal. Progress arrives as one-off events, so the last one is kept here and
// replayed to whoever asks — otherwise the screen falls back to "Add
// subscription" while the person is still confirming in Telegram.
let lastProgress: ConnectProgress | null = null

export function cancelSubscriptionConnect(): void {
  cancelled = true
  lastProgress = null
}

export function getPendingSubscriptionConnect(): ConnectProgress | null {
  return running ? lastProgress : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// FastAPI returns `detail` as a string, as an object, or — for validation
// errors — as an array. Reading it blindly is how a client crashes on the one
// branch nobody tested.
function detailOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const detail = (data as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map((d) => detailOf({ detail: d })).join('; ')
  if (typeof detail === 'object' && detail !== null) {
    const o = detail as Record<string, unknown>
    return String(o.msg ?? o.message ?? o.code ?? '')
  }
  return ''
}

class ConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectError'
  }
}

function retryAfterMs(headers: unknown): number {
  const raw = (headers as Record<string, string> | undefined)?.['retry-after']
  const seconds = parseInt(String(raw ?? ''), 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000
}

interface DeepLinkToken {
  token: string
  botUsername: string
  ttlMs: number
}

async function requestDeepLink(): Promise<DeepLinkToken> {
  const res = await axios.post(
    CABINET_BASE + PATH_DEEPLINK_REQUEST,
    {},
    { timeout: REQUEST_TIMEOUT, validateStatus: null }
  )
  if (res.status === 429) {
    throw new ConnectError(t('error.connectTooManyRequests'))
  }
  if (res.status !== 200) {
    const detail = detailOf(res.data)
    if (detail === 'Bot not configured') {
      throw new ConnectError(t('error.connectBotUnavailable'))
    }
    throw new ConnectError(connectErrorMessage(detail, res.status))
  }
  const data = res.data as { token?: string; bot_username?: string; expires_in?: number }
  if (!data.token || !data.bot_username) {
    throw new ConnectError(connectErrorMessage(undefined, res.status))
  }
  return {
    token: data.token,
    botUsername: data.bot_username,
    ttlMs: (data.expires_in || DEFAULT_TOKEN_TTL) * 1000
  }
}

interface Session {
  accessToken: string
}

// Resolves once the person confirms in Telegram. 202 means "not yet" and is
// deliberately not treated as success: it is a 2xx that carries an error body,
// so anything that only checks res.ok would store undefined tokens.
async function pollForSession(token: string, deadline: number, report: Report): Promise<Session> {
  let consecutiveRateLimits = 0

  for (;;) {
    if (cancelled) throw new ConnectError(t('error.connectCancelled'))
    if (Date.now() > deadline) throw new ConnectError(t('error.connectNotConfirmed'))

    const res = await axios.post(
      CABINET_BASE + PATH_DEEPLINK_POLL,
      { token },
      { timeout: REQUEST_TIMEOUT, validateStatus: null }
    )

    if (res.status === 200) {
      const data = res.data as { access_token?: string }
      if (!data.access_token) throw new ConnectError(connectErrorMessage(undefined, 200))
      return { accessToken: data.access_token }
    }

    if (res.status === 202) {
      consecutiveRateLimits = 0
      await sleep(POLL_INTERVAL)
      continue
    }

    if (res.status === 429) {
      // Rate limiting here is fail-closed on the server: a 429 can also mean
      // its Redis is down, so back off instead of calling the login failed.
      consecutiveRateLimits++
      if (consecutiveRateLimits >= 3) {
        report({ status: 'waiting', message: t('error.connectServerBusy') })
      }
      await sleep(retryAfterMs(res.headers))
      continue
    }

    const detail = detailOf(res.data)
    if (res.status === 410) throw new ConnectError(t('error.connectLinkExpired'))
    if (res.status === 403) throw new ConnectError(t('error.connectAccountDisabled'))
    if (res.status === 401) throw new ConnectError(t('error.connectNotAuthorized'))
    throw new ConnectError(connectErrorMessage(detail, res.status))
  }
}

export interface FetchedSubscription {
  url: string
  name?: string
}

async function fetchSubscription(session: Session): Promise<FetchedSubscription> {
  const res = await axios.get(CABINET_BASE + PATH_SUBSCRIPTION, {
    timeout: REQUEST_TIMEOUT,
    validateStatus: null,
    headers: { Authorization: `Bearer ${session.accessToken}` }
  })

  if (res.status !== 200) {
    throw new ConnectError(connectErrorMessage(detailOf(res.data), res.status))
  }

  const body = res.data as {
    has_subscription?: boolean
    subscription?: {
      subscription_url?: string | null
      is_active?: boolean
      is_expired?: boolean
      status?: string
      tariff_name?: string | null
    } | null
  }

  // Missing subscription is a 200 with has_subscription=false, not a 404.
  if (!body.has_subscription || !body.subscription) {
    throw new ConnectError(t('error.connectNoSubscription'))
  }
  const sub = body.subscription
  // The field is emptied to '' rather than null when a subscription is
  // revoked, so this has to be a truthy check.
  if (!sub.subscription_url) {
    throw new ConnectError(t('error.connectNoSubscription'))
  }
  if (sub.is_expired || sub.is_active === false) {
    throw new ConnectError(t('error.connectExpired'))
  }

  return { url: sub.subscription_url, name: sub.tariff_name || undefined }
}

// Runs the whole flow and reports progress. The caller imports the returned
// subscription; this module deliberately knows nothing about profiles.
export async function runSubscriptionConnect(report: Report): Promise<FetchedSubscription> {
  if (running) throw new ConnectError(t('error.connectAlreadyRunning'))
  running = true
  cancelled = false
  const track: Report = (p) => {
    lastProgress = p
    report(p)
  }
  try {
    track({ status: 'requesting' })
    const { token, botUsername, ttlMs } = await requestDeepLink()

    const link = `https://t.me/${botUsername}?start=webauth_${token}`
    // Failing to open Telegram must not abort the login: the card shows the
    // link too, so the person can still get there by hand.
    try {
      await shell.openExternal(link)
    } catch {
      // reported through the card below
    }
    track({ status: 'waiting', link })

    const session = await pollForSession(token, Date.now() + ttlMs, track)

    track({ status: 'fetching' })
    return await fetchSubscription(session)
  } finally {
    running = false
    lastProgress = null
  }
}

// Anything unrecognised falls back to a generic message rather than leaking a
// raw payload into the interface.
export function connectErrorMessage(detail?: string, status?: number): string {
  switch (detail) {
    case 'Waiting for confirmation':
      return t('error.connectNotConfirmed')
    case 'Token expired or not found':
    case 'Invalid token state':
    case 'Token already consumed':
      return t('error.connectLinkExpired')
    case 'Account is deactivated':
      return t('error.connectAccountDisabled')
    case 'User not found':
      return t('error.connectNotAuthorized')
    case 'Too many requests':
      return t('error.connectTooManyRequests')
    default:
      return status ? `${t('error.connectGeneric')} (${status})` : t('error.connectGeneric')
  }
}
