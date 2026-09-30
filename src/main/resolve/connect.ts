import { shell } from 'electron'
import axios, { AxiosResponse } from 'axios'
import { t } from '../utils/i18n'
import {
  clearCabinetSession,
  getCabinetSession,
  setCabinetSession
} from './cabinet-session'

// One-click subscription flow, cabinet side.
//
//   1. POST /cabinet/auth/deeplink/request  -> { token, bot_username, expires_in }
//   2. send the person to confirm somewhere they are already signed in:
//        Telegram — https://t.me/<bot_username>?start=webauth_<token>
//        the site — <site>/connect-app?token=<token>
//   3. poll POST /cabinet/auth/deeplink/poll { token } until it answers 200
//   4. GET /cabinet/subscription with the bearer token -> subscription_url
//
// That confirmation step is what makes the flow safe: the person approves in a
// place they are already signed into, so the client never has to prove that a
// callback really came from us. Both routes share one token and one poll.
//
// Caddy strips the /api prefix before the app sees it, and the cabinet router
// is mounted with redirect_slashes=False: a trailing slash returns 404 rather
// than redirecting. Paths below are written exactly as they must be sent.
// SLAVANET_CABINET_BASE points the client at a stub or a staging cabinet; it
// exists so the whole flow, including every failure branch, can be exercised
// without touching production.
const CABINET_BASE = process.env.SLAVANET_CABINET_BASE || 'https://web.slavanet.org/api'
// The confirmation page is served by the site itself, next to /api. Deriving it
// from the same base keeps a stub cabinet on one host during testing.
const SITE_BASE = process.env.SLAVANET_SITE_BASE || CABINET_BASE.replace(/\/api\/?$/, '')
const PATH_DEEPLINK_REQUEST = '/cabinet/auth/deeplink/request'
const PATH_DEEPLINK_POLL = '/cabinet/auth/deeplink/poll'
const PATH_SUBSCRIPTION = '/cabinet/subscription'
const PATH_EMAIL_LOGIN = '/cabinet/auth/email/login'
const PATH_REFRESH = '/cabinet/auth/refresh'
// /connect-app and NOT /connect: the shorter path is taken by the subscription
// deep-link redirect and declared earlier in the cabinet router, so a page
// mounted there never renders at all.
const PATH_CONNECT_PAGE = '/connect-app'

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
  via?: ConnectRoute
  code?: string
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

async function requestDeepLink(via: ConnectRoute): Promise<DeepLinkToken> {
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
    // Older cabinets answered 503 here when no bot username was set, which
    // killed the site route too. Kept for a cabinet that has not been updated.
    if (detail === 'Bot not configured') {
      throw new ConnectError(
        t(via === 'website' ? 'error.connectLoginUnavailable' : 'error.connectBotUnavailable')
      )
    }
    throw new ConnectError(connectErrorMessage(detail, res.status))
  }
  const data = res.data as { token?: string; bot_username?: string; expires_in?: number }
  if (!data.token) {
    throw new ConnectError(connectErrorMessage(undefined, res.status))
  }
  // The cabinet now answers 200 with an EMPTY bot_username instead of refusing
  // the whole route, so that the site route keeps working where no bot is
  // configured. Only the Telegram route is stuck then — and it says so, rather
  // than falling through to a generic "could not get the subscription".
  if (via === 'telegram' && !data.bot_username) {
    throw new ConnectError(t('error.connectBotUnavailable'))
  }
  return {
    token: data.token,
    botUsername: data.bot_username ?? '',
    ttlMs: (data.expires_in || DEFAULT_TOKEN_TTL) * 1000
  }
}

// E-mail and Telegram end in the identical response, so everything below is
// shared between them.
function storeAuthResponse(data: unknown, opts?: { keepRefresh?: boolean }): void {
  const d = (data ?? {}) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!d.access_token) throw new ConnectError(connectErrorMessage(undefined, 200))
  // A response that carries no refresh_token must not blank the stored one:
  // that turns a successful refresh into a session which can never be
  // refreshed again, and the person is signed out at the next access expiry.
  const refreshToken =
    d.refresh_token ?? (opts?.keepRefresh ? (getCabinetSession()?.refreshToken ?? '') : '')
  setCabinetSession({
    accessToken: d.access_token,
    refreshToken,
    expiresAt: Date.now() + (d.expires_in ?? 900) * 1000
  })
}

async function refreshSession(): Promise<boolean> {
  const current = getCabinetSession()
  if (!current?.refreshToken) return false
  const res = await axios.post(
    CABINET_BASE + PATH_REFRESH,
    // rotate asks for a NEW refresh token instead of the same one back. The
    // expiry is baked into the JWT, so without rotation the seven-day window
    // never moves and the person is signed out a week after logging in
    // whatever they do. The replaced token stays valid for another 60 seconds,
    // so an answer lost on the way does not end the session.
    { refresh_token: current.refreshToken, rotate: true },
    { timeout: REQUEST_TIMEOUT, validateStatus: null }
  )
  if (res.status !== 200) {
    clearCabinetSession()
    return false
  }
  storeAuthResponse(res.data, { keepRefresh: true })
  return true
}

// One refresh and one retry, then the session is dropped — never a loop.
async function authorizedGet(apiPath: string): Promise<AxiosResponse> {
  const send = (): Promise<AxiosResponse> =>
    axios.get(CABINET_BASE + apiPath, {
      timeout: REQUEST_TIMEOUT,
      validateStatus: null,
      headers: { Authorization: `Bearer ${getCabinetSession()?.accessToken ?? ''}` }
    })
  let res = await send()
  if (res.status === 401 && (await refreshSession())) {
    res = await send()
  }
  return res
}

// Resolves once the person confirms, in Telegram or on the site — the poll is
// the same for both and knows nothing about the route. 202 means "not yet" and is
// deliberately not treated as success: it is a 2xx that carries an error body,
// so anything that only checks res.ok would store undefined tokens.
async function pollForSession(
  token: string,
  deadline: number,
  report: Report,
  via: ConnectRoute
): Promise<void> {
  let consecutiveRateLimits = 0
  let consecutiveNetworkErrors = 0
  // Whether the screen is currently showing a "still trying" note, so it can
  // be taken back down once things work again instead of staying on screen
  // until the flow ends.
  let noteShown = false
  const note = (message?: string): void => {
    if (message) {
      noteShown = true
      report({ status: 'waiting', message })
    } else if (noteShown) {
      noteShown = false
      report({ status: 'waiting' })
    }
  }

  for (;;) {
    if (cancelled) throw new ConnectError(t('error.connectCancelled'))
    if (Date.now() > deadline) {
      throw new ConnectError(
        t(via === 'website' ? 'error.connectNotConfirmedSite' : 'error.connectNotConfirmed')
      )
    }

    let res: AxiosResponse
    try {
      res = await axios.post(
        CABINET_BASE + PATH_DEEPLINK_POLL,
        { token },
        { timeout: REQUEST_TIMEOUT, validateStatus: null }
      )
    } catch {
      // One poll that times out must not end a login the person has already
      // confirmed on the other side. The token lives for minutes, so keep
      // asking; only a network that stays down gives up.
      consecutiveNetworkErrors++
      if (consecutiveNetworkErrors >= 10) {
        throw new ConnectError(t('error.connectNetwork'))
      }
      if (consecutiveNetworkErrors >= 2) note(t('error.connectNetwork'))
      await sleep(POLL_INTERVAL)
      continue
    }
    consecutiveNetworkErrors = 0

    if (res.status === 200) {
      storeAuthResponse(res.data)
      return
    }

    if (res.status === 202) {
      consecutiveRateLimits = 0
      note()
      await sleep(POLL_INTERVAL)
      continue
    }

    if (res.status === 429) {
      // Rate limiting here is fail-closed on the server: a 429 can also mean
      // its Redis is down, so back off instead of calling the login failed.
      consecutiveRateLimits++
      if (consecutiveRateLimits >= 3) note(t('error.connectServerBusy'))
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

async function fetchSubscription(): Promise<FetchedSubscription> {
  const res = await authorizedGet(PATH_SUBSCRIPTION)

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
export async function runSubscriptionConnect(
  report: Report,
  via: ConnectRoute = 'telegram'
): Promise<FetchedSubscription> {
  if (running) throw new ConnectError(t('error.connectAlreadyRunning'))
  running = true
  cancelled = false
  const track: Report = (p) => {
    lastProgress = p
    report(p)
  }
  try {
    track({ status: 'requesting' })
    const { token, botUsername, ttlMs } = await requestDeepLink(via)

    const link =
      via === 'website'
        ? `${SITE_BASE}${PATH_CONNECT_PAGE}?token=${encodeURIComponent(token)}`
        : `https://t.me/${botUsername}?start=webauth_${token}`
    // Failing to open the browser or Telegram must not abort the login: the
    // card shows the link too, so the person can still get there by hand.
    try {
      await shell.openExternal(link)
    } catch {
      // reported through the card below
    }
    // The site page shows the first 8 characters of the token, and the card
    // shows the same ones, because the endpoint behind that page links
    // whatever token it is handed to whoever is signed in. Someone talked into
    // opening a token that is not theirs hands over their account — so the two
    // screens must be comparable. Telegram has nothing to compare against, so
    // there the code is left out rather than shown with no counterpart.
    track({
      status: 'waiting',
      link,
      via,
      code: via === 'website' ? token.slice(0, 8) : undefined
    })

    await pollForSession(token, Date.now() + ttlMs, track, via)

    track({ status: 'fetching' })
    return await fetchSubscription()
  } finally {
    running = false
    lastProgress = null
  }
}

// Fetch the subscription with the session we already have. This is what a
// slavanet://connect link from the website lands on for someone who signed in
// before: nothing to type, nothing to confirm.
export async function runSubscriptionFromSession(report: Report): Promise<FetchedSubscription> {
  if (running) throw new ConnectError(t('error.connectAlreadyRunning'))
  running = true
  cancelled = false
  const track: Report = (p) => {
    lastProgress = p
    report(p)
  }
  try {
    track({ status: 'fetching' })
    return await fetchSubscription()
  } finally {
    running = false
    lastProgress = null
  }
}

// Sign in with the cabinet account. This is the path that does not depend on
// Telegram being reachable — which matters, because it often is not where our
// clients are, and subscriptions are sold through the site.
export async function runEmailLogin(
  email: string,
  password: string,
  report: Report
): Promise<FetchedSubscription> {
  if (running) throw new ConnectError(t('error.connectAlreadyRunning'))
  running = true
  cancelled = false
  const track: Report = (p) => {
    lastProgress = p
    report(p)
  }
  try {
    track({ status: 'requesting' })
    const res = await axios.post(
      CABINET_BASE + PATH_EMAIL_LOGIN,
      { email: email.trim(), password },
      { timeout: REQUEST_TIMEOUT, validateStatus: null }
    )
    if (res.status !== 200) {
      throw new ConnectError(emailLoginError(res.status, detailOf(res.data), res.headers))
    }
    storeAuthResponse(res.data)
    track({ status: 'fetching' })
    return await fetchSubscription()
  } finally {
    running = false
    lastProgress = null
  }
}

// The cabinet deliberately merges "no such user", "wrong password" and
// "account blocked" into one 401 so nobody can probe for addresses. The client
// must not try to guess between them either.
function emailLoginError(status: number, detail: string, headers: unknown): string {
  if (status === 401) {
    return detail === 'Password login not configured for this account'
      ? t('error.loginNoPassword')
      : t('error.loginBadCredentials')
  }
  if (status === 403) return t('error.loginVerifyEmail')
  if (status === 422) return t('error.loginInvalidInput')
  if (status === 429) {
    // A long Retry-After means the per-address limit, not the per-IP one —
    // and that one also counts successful logins, so the advice differs.
    return retryAfterMs(headers) > 300_000
      ? t('error.loginTooManyForAccount')
      : t('error.connectTooManyRequests')
  }
  return connectErrorMessage(detail, status)
}

// Drops the stored session. Used by "sign out" and when the person wants to
// connect a different account.
export function signOutOfCabinet(): void {
  clearCabinetSession()
}

export function hasCabinetSession(): boolean {
  return getCabinetSession() !== null
}

// ── Подключённые устройства ─────────────────────────────────────────────────
// Кабинет отдаёт их по /cabinet/subscription/devices, забирая из панели
// Remnawave. Это отдельный от входа сценарий: сессия уже есть, подтверждать
// ничего не нужно — поэтому флаг running здесь не используется и запрос не
// мешает идущему входу.
//
// ⚠️ Запрос НЕ делается на старте приложения — только когда человек открыл
// раздел подписки. Это поход в сеть с bearer-токеном, и совершать его ради
// экрана, на который никто не смотрел, незачем.
const PATH_DEVICES = '/cabinet/subscription/devices'

// То, что реально приходит в элементе массива devices. Пишем как unknown-поля
// и разбираем руками: кабинет прокидывает значения панели почти как есть, и
// любое из них может оказаться null.
interface RawCabinetDevice {
  hwid?: unknown
  platform?: unknown
  device_model?: unknown
  local_name?: unknown
  app?: unknown
  os_version?: unknown
  last_seen_at?: unknown
  first_seen_at?: unknown
  created_at?: unknown
}

// Панель отдаёт времена ISO-строками, кабинет прокидывает их как есть. Разбор
// здесь, а не в интерфейсе: в приложении все даты — числа (ProfileItem.updated,
// SubscriptionUserInfo.expire), и рендерер не должен ловить Invalid Date.
function deviceTime(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // Секунды или миллисекунды: 1e12 мс — это 2001 год, а epoch в секундах
    // такого значения не достигнет ещё тысячи лет.
    return raw < 1e12 ? raw * 1000 : raw
  }
  if (typeof raw !== 'string' || !raw) return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

function optionalText(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw : undefined
}

function mapDevice(raw: RawCabinetDevice): CabinetDevice {
  return {
    // hwid может не прийти вовсе: кабинет берёт первое из hwid/deviceId/id, и
    // если панель не дала ни одного — будет null. Устройство всё равно
    // показываем: прятать от человека железку, которая жжёт его лимит, хуже,
    // чем показать её без идентификатора. Рендереру нужен ключ для списка —
    // на пустом hwid он обязан падать на индекс.
    hwid: typeof raw.hwid === 'string' ? raw.hwid : '',
    // Кабинет сам подставляет сюда 'Unknown', когда панель молчит, — так и
    // прокидываем, решение про подпись за интерфейсом.
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    model: typeof raw.device_model === 'string' ? raw.device_model : '',
    localName: optionalText(raw.local_name),
    app: optionalText(raw.app),
    osVersion: optionalText(raw.os_version),
    // last_seen_at кабинет добавил позже, а created_at у него исторически
    // значит «последняя активность» (в него первым идёт updatedAt панели).
    // Поэтому фолбэк именно такой: на кабинете постарше поле новое пустое.
    lastSeenAt: deviceTime(raw.last_seen_at) ?? deviceTime(raw.created_at),
    firstSeenAt: deviceTime(raw.first_seen_at)
  }
}

// Своё сообщение, а не connectErrorMessage: тот говорит «не удалось получить
// подписку», и на экране устройств это врёт про то, что именно сломалось.
function devicesErrorMessage(status: number): string {
  return `${t('error.devicesUnavailable')} (${status})`
}

let devicesInFlight: Promise<CabinetDevicesResult> | null = null

// Список устройств для раздела подписки. Никогда не бросает: «устройств нет»,
// «надо войти» и «не смогли спросить» — это разные ответы, а не исключения,
// и интерфейс обязан их различать (см. CabinetDevicesResult).
export function fetchCabinetDevices(): Promise<CabinetDevicesResult> {
  // Раздел подписки легко открыть дважды (перерисовка, возврат на экран), а
  // два параллельных запроса с истёкшим токеном полезут обновлять его каждый
  // своим refresh: rotate:true заменяет refresh-токен, и второй запрос пойдёт
  // уже отозванным — сессия умрёт на ровном месте. Поэтому один запрос в полёте.
  if (devicesInFlight) return devicesInFlight
  const run = loadCabinetDevices().finally(() => {
    devicesInFlight = null
  })
  devicesInFlight = run
  return run
}

async function loadCabinetDevices(): Promise<CabinetDevicesResult> {
  // Без сессии в сеть не идём вообще. Пустой Bearer вернул бы тот же 401, но
  // это лишний запрос, а главное — интерфейсу здесь нужно предложить вход, а
  // не показывать «устройств нет».
  if (!getCabinetSession()) return { state: 'unauthorized' }

  let res: AxiosResponse
  try {
    res = await authorizedGet(PATH_DEVICES)
  } catch {
    // Сети нет — это «пока не знаем», а не «устройств нет».
    return { state: 'error', message: t('error.connectNetwork') }
  }

  // 401 приходит уже ПОСЛЕ одного обновления токена внутри authorizedGet.
  // Сессию здесь не стираем: провал одного экрана — не повод выкидывать
  // человека из аккаунта, а состояния unauthorized интерфейсу хватает, чтобы
  // предложить вход. Учти в рендерере: hasCabinetSession() при этом может
  // всё ещё отвечать true.
  if (res.status === 401) return { state: 'unauthorized' }
  if (res.status === 403) return { state: 'error', message: t('error.connectAccountDisabled') }
  if (res.status === 429) return { state: 'error', message: t('error.connectTooManyRequests') }
  if (res.status === 404) {
    // 404 у этого маршрута двусмысленный: либо у аккаунта нет подписки, либо
    // кабинет старый и ручки просто нет. Разделяем по detail — иначе клиент
    // соврёт «нет подписки» человеку с живой подпиской.
    return detailOf(res.data) === 'No subscription found'
      ? { state: 'noSubscription' }
      : { state: 'error', message: devicesErrorMessage(res.status) }
  }
  if (res.status !== 200) {
    return { state: 'error', message: devicesErrorMessage(res.status) }
  }

  // 200 с не-объектом в теле — это не «устройств нет», а что-то ответило
  // вместо кабинета (страница ошибки прокси, например). Лучше честная ошибка с
  // кнопкой «повторить», чем пустой список, которому человек поверит.
  if (typeof res.data !== 'object' || res.data === null) {
    return { state: 'error', message: devicesErrorMessage(res.status) }
  }
  const body = res.data as { devices?: unknown; total?: unknown; device_limit?: unknown }
  // Элемент списка может оказаться null — пропускаем такой, а не падаем на
  // всём разделе из-за одной битой записи.
  const rawDevices: unknown[] = Array.isArray(body.devices) ? body.devices : []
  const devices = rawDevices
    .filter((d): d is RawCabinetDevice => typeof d === 'object' && d !== null)
    .map(mapDevice)
  // total приходит из панели и в теории может расходиться с длиной списка.
  // Берём максимум: занизить счётчик на экране лимита хуже, чем завысить.
  const reported = typeof body.total === 'number' && Number.isFinite(body.total) ? body.total : 0
  const total = Math.max(reported, devices.length)
  // device_limit = 0 означает «лимит не задан», а не «ноль устройств», —
  // поэтому наружу отдаём undefined, чтобы интерфейс не нарисовал «0 из 0».
  const limit =
    typeof body.device_limit === 'number' && body.device_limit > 0 ? body.device_limit : undefined

  // Пустой список — нормальное состояние, а не отказ. И ровно то же (200 и [])
  // кабинет отдаёт, когда панель недоступна: по ответу эти два случая не
  // отличаются. Поэтому оба — state: 'ok', а текст на экране должен быть
  // сдержанным («устройств пока не видно»), а не утверждать, что их нет.
  return { state: 'ok', devices, total, limit }
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
