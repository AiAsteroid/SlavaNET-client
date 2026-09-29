import { randomBytes } from 'crypto'
import { app, shell } from 'electron'
import axios from 'axios'
import { getDeviceModel, getDeviceOS, getHWID, getOSVersion } from '../utils/deviceInfo'
import { getUserAgent } from '../utils/userAgent'
import { t } from '../utils/i18n'

// One-click subscription flow.
//
// The app opens the cabinet in the default browser. The cabinet checks the
// session and sends the user back with a slavanet:// link. Two callback shapes
// are accepted (see handleDeepLink):
//
//   slavanet://connect?ticket=<one-time>&state=<state>   preferred
//   slavanet://install-config?url=<subscription>&state=<state>
//
// `state` is generated here before the browser is opened and is required for
// every callback that skips the import confirmation: without it we cannot tell
// our own round trip from a link somebody else made the user click.
//
// TODO(server): both endpoints below live in the cabinet and do not exist yet.
// They are owned by the VPN session, not by this repo. Confirm the final hosts
// and paths before shipping.
const CONNECT_ENTRY_URL = 'https://web.slavanet.org/connect/desktop'
const TICKET_REDEEM_URL = 'https://web.slavanet.org/api/desktop/redeem'

// A pending round trip is only valid for a few minutes. It is kept in memory on
// purpose: if the app is quit while the browser is open the flow is abandoned
// rather than resumable, which is what a single-use state check should do.
const PENDING_TTL = 5 * 60 * 1000

interface PendingConnect {
  state: string
  createdAt: number
}

let pending: PendingConnect | null = null

export function hasPendingConnect(): boolean {
  if (!pending) return false
  if (Date.now() - pending.createdAt > PENDING_TTL) {
    pending = null
    return false
  }
  return true
}

export function cancelPendingConnect(): void {
  pending = null
}

// Single use: once a state is presented it is dropped whether or not it
// matched, so a leaked callback cannot be replayed. A callback that carries no
// state at all is left alone — otherwise any unrelated clash:// link would
// cancel a round trip the user has just started.
export function consumePendingState(state: string | null | undefined): boolean {
  if (!state) return false
  const current = pending
  pending = null
  if (!current) return false
  if (Date.now() - current.createdAt > PENDING_TTL) return false
  return current.state === state
}

export async function startSubscriptionConnect(): Promise<void> {
  const state = randomBytes(24).toString('base64url')
  pending = { state, createdAt: Date.now() }

  const url = new URL(CONNECT_ENTRY_URL)
  url.searchParams.set('state', state)
  url.searchParams.set('platform', process.platform)
  url.searchParams.set('version', app.getVersion())
  url.searchParams.set('hwid', getHWID())

  try {
    await shell.openExternal(url.toString())
  } catch (e) {
    pending = null
    throw e
  }
}

interface RedeemedSubscription {
  url: string
  name?: string
}

// Exchanges a one-time ticket for the actual subscription URL over HTTPS, so
// the subscription link itself never travels through a URL scheme, the browser
// history or the redirect logs.
export async function redeemTicket(ticket: string): Promise<RedeemedSubscription> {
  const res = await axios.post(
    TICKET_REDEEM_URL,
    { ticket },
    {
      timeout: 15000,
      headers: {
        'User-Agent': await getUserAgent(),
        'x-hwid': getHWID(),
        'x-device-os': getDeviceOS(),
        'x-ver-os': getOSVersion(),
        'x-device-model': getDeviceModel()
      },
      // Error bodies carry a machine-readable reason we want to map to a
      // message, so do not let axios throw on them.
      validateStatus: null
    }
  )

  const data = (res.data ?? {}) as { url?: string; name?: string; reason?: string }

  if (res.status !== 200 || !data.url) {
    throw new Error(connectErrorMessage(data.reason, res.status))
  }

  return { url: data.url, name: data.name }
}

// Reasons the cabinet can return. Anything unknown falls back to a generic
// message rather than leaking a raw payload into the UI.
export function connectErrorMessage(reason?: string, status?: number): string {
  switch (reason) {
    case 'not_authorized':
      return t('error.connectNotAuthorized')
    case 'no_subscription':
      return t('error.connectNoSubscription')
    case 'subscription_expired':
      return t('error.connectExpired')
    case 'device_limit':
      return t('error.connectDeviceLimit')
    case 'ticket_expired':
      return t('error.connectTicketExpired')
    default:
      return status ? `${t('error.connectGeneric')} (${status})` : t('error.connectGeneric')
  }
}
