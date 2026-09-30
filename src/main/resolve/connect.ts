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

// FastAPI отдаёт detail и объектом: {code, message, required_kopeks, ...}.
// detailOf выше сплющивает его в строку — для денег этого мало, нужны числа
// (сколько не хватает, сколько списали), поэтому объект достаём отдельно.
function detailRecord(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const detail = (data as { detail?: unknown }).detail
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return undefined
  return detail as Record<string, unknown>
}

function detailCode(data: unknown): string {
  const code = detailRecord(data)?.code
  return typeof code === 'string' ? code : ''
}

// Числа из ответа берём СТРОГО числами. Никакого Number(raw): цена, пришедшая
// строкой, значит, что отвечал не наш кабинет, и молча превратить её в число —
// это показать человеку сумму, которую мы выдумали.
function numberOf(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

// Текст отказа от сервера можно показывать человеку не всегда. Пользовательские
// причины кабинет пишет по-русски и с числами («Максимальное количество
// устройств: 20. Баланс возвращён.») — такой текст точнее любого нашего.
// Технические detail того же API английские («No subscription found», «Failed to
// delete device») или вовсе массивы валидации — их в интерфейс не пускаем.
// Поэтому фильтр по наличию кириллицы: это проверяемое свойство кабинета, а не
// догадка. ⚠️ Следствие: в нерусской локали пользовательская причина придёт
// по-русски. Это лучше, чем потерять сумму и лимит из сообщения.
function safeDetail(raw: string): string {
  const text = raw.trim().replace(/\s+/g, ' ')
  if (!text || text.length > 200) return ''
  if (!/[а-яё]/i.test(text)) return ''
  return text
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

// Одно обновление токена на всех, кто его сейчас ждёт. rotate:true ЗАМЕНЯЕТ
// refresh-токен, поэтому два параллельных обновления убивают сессию: второе
// уходит уже отозванным токеном. Раньше от этого спасала дедупликация в
// fetchCabinetDevices, но запросов стало больше одного, и защита должна стоять
// у самого обновления, а не у каждого вызова.
let refreshInFlight: Promise<boolean> | null = null

function refreshSessionShared(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  const run = refreshSession().finally(() => {
    refreshInFlight = null
  })
  refreshInFlight = run
  return run
}

type CabinetMethod = 'get' | 'post' | 'patch' | 'delete'

interface AuthorizedOptions {
  body?: unknown
  query?: Record<string, string | number | undefined>
}

// Собираем query сами, а не через URLSearchParams: тот превращает undefined в
// строку «undefined» и отправляет `?type=undefined`. Для фильтра истории это
// значит запрос несуществующего типа операций и пустую историю без ошибки.
function queryString(query?: Record<string, string | number | undefined>): string {
  if (!query) return ''
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// One refresh and one retry, then the session is dropped — never a loop.
//
// ⚠️ ДЕНЬГИ: повтор после обновления токена безопасен даже для POST /purchase,
// и это проверено по коду сервера, а не предположено. Все 401 на этих
// маршрутах поднимает зависимость get_current_cabinet_user
// (app/cabinet/dependencies.py) ДО тела обработчика; в самих devices.py и
// balance.py слова 401 нет вовсе. То есть ответ 401 означает, что обработчик не
// запускался и списания не было. Повторяем ТОЛЬКО на 401 — ни на 5xx, ни на
// таймауте: там списание уже могло произойти.
async function authorizedRequest(
  method: CabinetMethod,
  apiPath: string,
  opts: AuthorizedOptions = {}
): Promise<AxiosResponse> {
  const url = CABINET_BASE + apiPath + queryString(opts.query)
  const send = (): Promise<AxiosResponse> =>
    axios.request({
      method,
      url,
      data: opts.body,
      timeout: REQUEST_TIMEOUT,
      validateStatus: null,
      headers: { Authorization: `Bearer ${getCabinetSession()?.accessToken ?? ''}` }
    })
  let res = await send()
  if (res.status === 401 && (await refreshSessionShared())) {
    res = await send()
  }
  return res
}

async function authorizedGet(apiPath: string): Promise<AxiosResponse> {
  return authorizedRequest('get', apiPath)
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

// Панель отдаёт времена ISO-строками, кабинет прокидывает их как есть; даты
// транзакций приходят оттуда же через pydantic. Разбор здесь, а не в
// интерфейсе: в приложении все даты — числа (ProfileItem.updated,
// SubscriptionUserInfo.expire), и рендерер не должен ловить Invalid Date.
function apiTime(raw: unknown): number | undefined {
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
    lastSeenAt: apiTime(raw.last_seen_at) ?? apiTime(raw.created_at),
    firstSeenAt: apiTime(raw.first_seen_at)
  }
}

// Своё сообщение, а не connectErrorMessage: тот говорит «не удалось получить
// подписку», и на экране устройств это врёт про то, что именно сломалось.
function devicesErrorMessage(status: number): string {
  return `${t('error.devicesUnavailable')} (${status})`
}

// Один запрос в полёте на каждый ключ. Раздел подписки легко открыть дважды
// (перерисовка, возврат на экран), и незачем спрашивать сервер два раза об
// одном и том же. Обновление токена от дублей защищено отдельно, в
// refreshSessionShared, — здесь речь только о лишних походах в сеть.
//
// ⚠️ Это НЕ защита денег. Покупка защищена своим замком ниже: там мало
// «склеить одинаковые вызовы», там второй вызов обязан получить отказ.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readsInFlight = new Map<string, Promise<any>>()

function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = readsInFlight.get(key) as Promise<T> | undefined
  if (existing) return existing
  const started = run().finally(() => {
    readsInFlight.delete(key)
  })
  readsInFlight.set(key, started)
  return started
}

// Список устройств для раздела подписки. Никогда не бросает: «устройств нет»,
// «надо войти» и «не смогли спросить» — это разные ответы, а не исключения,
// и интерфейс обязан их различать (см. CabinetDevicesResult).
export function fetchCabinetDevices(): Promise<CabinetDevicesResult> {
  return singleFlight('devices', loadCabinetDevices)
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

// ── Кабинет: баланс, история, докупка устройств ─────────────────────────────
// Всё ниже стоит НАД authorizedRequest и его правилом «один refresh, один
// повтор». Своего axios-клиента здесь нет намеренно: второй клиент — это второй
// набор таймаутов, заголовков и правил обновления токена, которые через месяц
// разойдутся с флоу входа.
//
// Маршруты записаны так, как их надо отправлять: Caddy срезает /api, а роутер
// кабинета смонтирован с redirect_slashes=False — лишний слэш даёт 404, а не
// редирект. Цепочка префиксов: /cabinet + /subscription + /devices…
const PATH_BALANCE = '/cabinet/balance'
const PATH_BALANCE_TRANSACTIONS = '/cabinet/balance/transactions'
const PATH_DEVICE_PRICE = '/cabinet/subscription/devices/price'
const PATH_DEVICE_PURCHASE = '/cabinet/subscription/devices/purchase'
// Устаревшего POST /cabinet/subscription/devices (без /purchase) здесь нет и не
// будет: он помечен DEPRECATED и считает цену своим кодом, расходящимся с
// ручкой цены. POST /devices/reduce и DELETE /devices (отключить ВСЕ) тоже
// отсутствуют сознательно — первое не возвращает деньги и само выбирает, что
// отключить, второе слишком дорого ошибиться.

// Сколько живёт расчёт цены. Остаток дней сервер считает как
// ceil((end_date − now) / 86400) в момент запроса (devices.py:827), то есть на
// границе суток цена меняется сама. Короткий срок нужен, чтобы человек
// подтверждал ту цифру, которую сервер назвал только что.
const QUOTE_TTL = 90_000
// Покупка принимает 1..100 (DevicePurchaseRequest.devices, ge=1 le=100), а
// ручка цены не валидирует ничего вообще (`devices: int = 1`) и посчитает цену
// для любого числа. Проверяем границы САМИ и отказываем до запроса: иначе
// человеку покажут цену того, что покупка потом отвергнет 422.
const MAX_DEVICES_PER_PURCHASE = 100
// Столько символов оставляет от имени сервер (ALIAS_MAX_LENGTH в
// app/database/crud/user_device_alias.py). Режем так же и у себя, чтобы на
// экране стояло ровно то, что сохранилось, а не обрезанное молча.
const DEVICE_NAME_MAX_LENGTH = 64

function withStatus(key: string, status: number): string {
  return `${t(key)} (${status})`
}

// Причина отказа: сначала то, что написал сервер (он единственный знает числа),
// иначе свой текст плюс код состояния — чтобы поддержка по скриншоту понимала,
// о чём речь.
function reasonMessage(res: AxiosResponse, fallbackKey: string): string {
  return safeDetail(detailOf(res.data)) || withStatus(fallbackKey, res.status)
}

// Разбор отказа, общий для всех вызовов кабинета. Состояния разделены не ради
// красоты: «войдите заново», «нет подписки», «сервер на обслуживании» и «сервер
// сломался» требуют от интерфейса разных кнопок. Возвращает null, когда отказа
// нет и вызывающий может разбирать тело.
//
// ⚠️ Покупка НЕ использует это отображение напрямую: там 402, 409 и 5xx значат
// вещи про деньги, которых у остальных вызовов нет. См. purchaseFailure.
function cabinetFailure(res: AxiosResponse): CabinetFailure | null {
  if (res.status === 200) return null
  const detail = detailOf(res.data)
  const code = detailCode(res.data)

  // 401 приходит уже ПОСЛЕ одного обновления токена внутри authorizedRequest.
  // Сессию не стираем: провал одного экрана — не повод выкидывать человека из
  // аккаунта. Учти в рендерере, что hasCabinetSession() при этом ещё true.
  if (res.status === 401) return { state: 'unauthorized' }

  if (res.status === 403) {
    // restriction_subscription — это запрет ТОЛЬКО на покупки, аккаунт живой;
    // blacklisted/account_deleted — про аккаунт целиком. Один текст на оба
    // случая соврал бы в обе стороны.
    if (detail === 'Subscription purchases are restricted for this account') {
      return { state: 'forbidden', message: t('error.cabinetPurchaseRestricted') }
    }
    if (code === 'blacklisted' || code === 'account_deleted') {
      return { state: 'forbidden', message: t('error.connectAccountDisabled') }
    }
    return { state: 'forbidden', message: t('error.cabinetForbidden') }
  }

  if (res.status === 404) {
    // 404 у этих маршрутов двусмысленный: «нет подписки», «нет устройства» и
    // «кабинет старый, ручки нет» — разные вещи. Различаем по detail, иначе
    // клиент соврёт «нет подписки» человеку с живой подпиской.
    if (detail === 'No subscription found' || detail === 'Subscription not found') {
      return { state: 'noSubscription' }
    }
    return { state: 'notFound', message: withStatus('error.cabinetNotFound', res.status) }
  }

  if (res.status === 400) {
    // Так отвечает покупка, когда подписки нет вовсе (в отличие от списка
    // устройств, где это 404). Текст сервера русский, но состояние важнее
    // текста: интерфейс должен предложить купить подписку, а не «повторить».
    if (detail === 'У вас нет активной подписки') return { state: 'noSubscription' }
    return { state: 'rejected', message: reasonMessage(res, 'error.cabinetRejected') }
  }

  // Валидацию FastAPI отдаёт массивом объектов — в интерфейс такой текст не
  // пускаем, это наша ошибка в параметрах, а не сообщение человеку.
  if (res.status === 422) {
    return { state: 'rejected', message: withStatus('error.cabinetRejected', res.status) }
  }

  if (res.status === 409) {
    return { state: 'conflict', message: reasonMessage(res, 'error.cabinetConflict') }
  }

  if (res.status === 429) {
    // На самих маршрутах устройств и баланса лимитера в приложении нет —
    // значит 429 пришёл от Caddy или от чего-то перед ним. Лечится ожиданием,
    // а не повторным нажатием.
    return { state: 'rateLimited', message: t('error.connectTooManyRequests') }
  }

  if (res.status === 503 && code === 'maintenance') {
    // Текст обслуживания админ пишет сам, по-русски, и он информативнее нашего
    // («вернёмся в 14:00»). Берём его, если он прошёл фильтр.
    const raw = detailRecord(res.data)?.message
    const own = typeof raw === 'string' ? safeDetail(raw) : ''
    return { state: 'maintenance', message: own || t('error.cabinetMaintenance') }
  }

  if (res.status >= 500) {
    return { state: 'serverError', message: withStatus('error.cabinetServerError', res.status) }
  }

  return { state: 'unexpected', message: withStatus('error.cabinetUnexpected', res.status) }
}

// Тело 200 обязано быть объектом. 200 со строкой или null — это не «пусто», это
// что-то ответило ВМЕСТО кабинета (страница ошибки прокси, капча провайдера).
// Честная ошибка с кнопкой «повторить» лучше пустого экрана, которому поверят.
// null здесь значит «читать нечего», а не «пусто»: у каждого вызывающего на
// этот случай свой ответ, и у покупки он особый — 'unknown', а не badResponse.
function objectBody(res: AxiosResponse): Record<string, unknown> | null {
  if (typeof res.data !== 'object' || res.data === null || Array.isArray(res.data)) return null
  return res.data as Record<string, unknown>
}

function badResponse(res: AxiosResponse): CabinetFailure {
  return { state: 'badResponse', message: withStatus('error.cabinetBadResponse', res.status) }
}

// Отправлен ли запрос — вопрос про деньги, а не про удобство. Достоверно «не
// отправлен» только то, что сломалось ДО соединения: имя не разрешилось,
// соединение отвергнуто, маршрута нет. Таймаут, обрыв и сброс означают, что
// запрос МОГ дойти, а значит списание МОГЛО произойти.
//
// Ошибаемся сознательно в сторону «не знаем»: ложное «не отправлено» приведёт к
// повторной покупке за тысячу рублей, ложное «не знаем» — к лишней проверке
// баланса.
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_INVALID_URL',
  'ERR_BAD_OPTION',
  'ERR_BAD_OPTION_VALUE'
])

function requestDefinitelyNotSent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && NOT_SENT_CODES.has(code)
}

// ── Баланс ──────────────────────────────────────────────────────────────────

export function fetchCabinetBalance(): Promise<CabinetBalanceResult> {
  return singleFlight('balance', loadCabinetBalance)
}

async function loadCabinetBalance(): Promise<CabinetBalanceResult> {
  if (!getCabinetSession()) return { state: 'unauthorized' }

  let res: AxiosResponse
  try {
    res = await authorizedRequest('get', PATH_BALANCE)
  } catch {
    return { state: 'network', message: t('error.connectNetwork') }
  }

  const failure = cabinetFailure(res)
  if (failure) return failure
  const body = objectBody(res)
  if (!body) return badResponse(res)

  // balance_kopeks — единственное, что нам нужно, и без него ответ бесполезен.
  // Подставить 0 нельзя: «на балансе 0 ₽» человек прочитает как факт.
  const balanceKopeks = numberOf(body.balance_kopeks)
  if (balanceKopeks === undefined) return badResponse(res)
  return { state: 'ok', balanceKopeks }
}

// ── История операций ───────────────────────────────────────────────────────

function mapTransaction(raw: Record<string, unknown>): CabinetTransaction | null {
  const id = numberOf(raw.id)
  const amountKopeks = numberOf(raw.amount_kopeks)
  // Запись без числового id ИЛИ без суммы показать нечестно: сумму пришлось бы
  // выдумать, а без id список в рендерере потеряет ключи и начнёт путать
  // строки местами. Такие записи не теряем молча, а считаем (см. skipped).
  if (id === undefined || amountKopeks === undefined) return null
  return {
    id,
    type: typeof raw.type === 'string' ? raw.type : '',
    // Знак расставляет сервер: списания (subscription_payment, withdrawal,
    // gift_payment) приходят отрицательными (balance.py:109-110). Своей логики
    // знаков здесь нет специально — две реализации разойдутся.
    amountKopeks,
    description: optionalText(raw.description),
    paymentMethod: optionalText(raw.payment_method),
    completed: raw.is_completed === true,
    createdAt: apiTime(raw.created_at),
    completedAt: apiTime(raw.completed_at)
  }
}

export function fetchCabinetTransactions(
  params: CabinetTransactionsParams = {}
): Promise<CabinetTransactionsResult> {
  // Сервер принимает page ≥ 1 и per_page 1..100 (balance.py:75-76); за
  // границами — 422. Зажимаем здесь, чтобы ошибка в интерфейсе не выглядела
  // как поломка кабинета.
  const page = Math.max(1, Math.floor(numberOf(params.page) ?? 1))
  const perPage = Math.min(100, Math.max(1, Math.floor(numberOf(params.perPage) ?? 20)))
  const rawType = typeof params.type === 'string' ? params.type.trim() : ''
  const type = rawType || undefined
  const key = `transactions:${page}:${perPage}:${type ?? ''}`
  return singleFlight(key, () => loadCabinetTransactions(page, perPage, type))
}

async function loadCabinetTransactions(
  page: number,
  perPage: number,
  type?: string
): Promise<CabinetTransactionsResult> {
  if (!getCabinetSession()) return { state: 'unauthorized' }

  let res: AxiosResponse
  try {
    res = await authorizedRequest('get', PATH_BALANCE_TRANSACTIONS, {
      query: { page, per_page: perPage, type }
    })
  } catch {
    return { state: 'network', message: t('error.connectNetwork') }
  }

  const failure = cabinetFailure(res)
  if (failure) return failure
  const body = objectBody(res)
  if (!body) return badResponse(res)

  const rawItems: unknown[] = Array.isArray(body.items) ? body.items : []
  const items: CabinetTransaction[] = []
  let skipped = 0
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) {
      skipped++
      continue
    }
    const mapped = mapTransaction(raw as Record<string, unknown>)
    if (mapped) items.push(mapped)
    else skipped++
  }

  // total и pages считает сервер по своему запросу; длина страницы с ними
  // может не совпасть, если мы что-то отбросили. Отдаём и то и другое:
  // «часть записей прочитать не удалось» человеку сказать надо, молча
  // показывать дыру в истории денег — нельзя.
  return {
    state: 'ok',
    items,
    skipped,
    total: numberOf(body.total) ?? items.length,
    page: numberOf(body.page) ?? page,
    perPage: numberOf(body.per_page) ?? perPage,
    pages: numberOf(body.pages) ?? 1
  }
}

// ── Докупка устройств: расчёт цены ──────────────────────────────────────────
// ⚠️ ДЕНЬГИ. Дальше всё про операцию, которая списывает с баланса МГНОВЕННО.
// Подтверждения на сервере нет, отката нет, маршрута возврата в
// пользовательском API не существует. Цена прорейтится по ВСЕМУ остатку
// подписки: при остатке 224 дня одно устройство по 200 ₽/мес стоит ≈1 493 ₽ —
// семь с половиной месячных цен за один тап. Серверные локи защищают только от
// превышения максимума устройств; от двух одинаковых нажатий они не защищают
// НИКАК — каждое спишет деньги.
//
// Отсюда вся конструкция ниже:
//   • цена всегда берётся с сервера прямо перед подтверждением;
//   • расчёт одноразовый, привязан к числу устройств и живёт 90 секунд;
//   • покупка принимает ТОЛЬКО идентификатор расчёта, а не число устройств, —
//     «посчитали за одно, купили пять» так становится невозможно;
//   • пока запрос в полёте, второй вызов получает отказ и в сеть не идёт.

// Последний выданный расчёт. Ровно один: покупка всегда относится к тому, что
// человек видит на экране прямо сейчас.
let lastQuote: CabinetDeviceQuote | null = null
let quoteCounter = 0

// Замок живёт в ГЛАВНОМ процессе, а не в интерфейсе. Рендерер обходится двойным
// событием, зажатым Enter, горячей клавишей и консолью разработчика; главный
// процесс — нет.
let purchaseInFlight = false
// Исход неизвестен: запрос ушёл, ответа не было. До тех пор, пока человек не
// пересчитает цену (а значит не увидит настоящий баланс и лимит), покупку не
// пускаем вовсе. Повторное нажатие после «не знаем» — это второе списание.
let purchaseOutcomeUnknown = false

// Расчёт цены: проверяет число устройств и снимает с сервера цену вместе с
// балансом. Звать НЕПОСРЕДСТВЕННО перед показом подтверждения. Результат
// кэшировать нельзя — остаток подписки уменьшается каждые сутки.
//
// ⚠️ Расчёт хранится ровно один, последний завершившийся. Если интерфейс
// запросит цену на 1 и на 2 одновременно, живым останется тот, чей ответ пришёл
// позже, и покупка по «чужому» идентификатору получит staleQuote. Это
// сознательный отказ в сторону безопасности: лучше попросить пересчитать, чем
// списать за не то количество.
export function fetchCabinetDeviceQuote(devices: number): Promise<CabinetDeviceQuoteResult> {
  const count = numberOf(devices)
  // Не зажимаем молча: если интерфейс попросил ноль, дробное или NaN, это его
  // ошибка, а посчитать «тогда одно» значит назвать человеку цену не того, что
  // он выбрал. Верхняя граница — та же, что у покупки: 100.
  if (
    count === undefined ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_DEVICES_PER_PURCHASE
  ) {
    return Promise.resolve<CabinetDeviceQuoteResult>({
      state: 'rejected',
      message: t('error.deviceCountInvalid')
    })
  }
  return singleFlight(`quote:${count}`, () => loadCabinetDeviceQuote(count))
}

async function loadCabinetDeviceQuote(devices: number): Promise<CabinetDeviceQuoteResult> {
  if (!getCabinetSession()) return { state: 'unauthorized' }

  let priceRes: AxiosResponse
  try {
    priceRes = await authorizedRequest('get', PATH_DEVICE_PRICE, { query: { devices } })
  } catch {
    return { state: 'network', message: t('error.connectNetwork') }
  }

  const priceFailure = cabinetFailure(priceRes)
  if (priceFailure) return priceFailure
  const priceBody = objectBody(priceRes)
  if (!priceBody) return badResponse(priceRes)

  // ⚠️ «Нельзя» эта ручка сообщает 200-м ответом с available:false и русской
  // причиной, а не кодом состояния: нет активной подписки, докупка выключена,
  // достигнут максимум, «можно добавить максимум N». Проверять только статус —
  // значит предложить человеку купить то, что сервер уже отказался продавать.
  if (priceBody.available !== true) {
    const reason = typeof priceBody.reason === 'string' ? safeDetail(priceBody.reason) : ''
    return {
      state: 'unavailable',
      reason: reason || t('error.devicePurchaseUnavailable'),
      currentLimit: numberOf(priceBody.current_device_limit),
      maxLimit: numberOf(priceBody.max_device_limit),
      canAdd: numberOf(priceBody.can_add)
    }
  }

  // Цена и остаток дней обязательны. Подставить ноль нельзя ни на секунду:
  // «0 ₽» в подтверждении — это разрешение списать любую сумму.
  const priceKopeks = numberOf(priceBody.total_price_kopeks)
  const currentLimit = numberOf(priceBody.current_device_limit)
  const daysLeft = numberOf(priceBody.days_left)
  if (priceKopeks === undefined || currentLimit === undefined || daysLeft === undefined) {
    return badResponse(priceRes)
  }
  // price_per_device_kopeks сервер получает целочисленным делением общей суммы
  // (devices.py:864) и оно не сходится с суммой при умножении. Берём только
  // total: в подтверждении должна стоять та цифра, которую спишут.
  const priceLabel =
    typeof priceBody.total_price_label === 'string' ? priceBody.total_price_label : ''

  // Баланс — вторым запросом: ручка цены его не отдаёт, а без баланса в
  // подтверждении нельзя назвать остаток после списания. Если баланс не
  // узнали, расчёт НЕ выдаём вовсе: половинчатое подтверждение («сумма есть,
  // остатка нет») хуже отсутствия — человек согласится, не понимая, на что.
  //
  // Идём через loadCabinetBalance, в обход дедупликации: на деньгах нужен
  // свежий ответ, а не подклеивание к запросу, который начался раньше и мог
  // прочитать баланс до чужого пополнения. И последовательно, не параллельно:
  // предсказуемый порядок здесь дороже сотни миллисекунд.
  const balance = await loadCabinetBalance()
  if (balance.state !== 'ok') return balance

  const enough = balance.balanceKopeks >= priceKopeks
  const quote: CabinetDeviceQuote = {
    id: `q${++quoteCounter}-${Date.now()}`,
    devices,
    priceKopeks,
    priceLabel,
    balanceKopeks: balance.balanceKopeks,
    // Может стать отрицательным — тогда enough=false, и это ровно то число,
    // которое объясняет человеку отказ.
    balanceAfterKopeks: balance.balanceKopeks - priceKopeks,
    enough,
    // ⚠️ currentLimit здесь — из ручки цены (`device_limit or 1`), а в списке
    // устройств кабинет отдаёт `device_limit or 0`. На незаданном лимите они
    // расходятся на единицу. В подтверждении показывай newLimit ИЗ РАСЧЁТА,
    // а не считай его от числа из списка устройств.
    currentLimit,
    newLimit: currentLimit + devices,
    maxLimit: numberOf(priceBody.max_device_limit),
    canAdd: numberOf(priceBody.can_add),
    daysLeft,
    discountPercent: numberOf(priceBody.discount_percent),
    expiresAt: Date.now() + QUOTE_TTL
  }

  lastQuote = quote
  // Свежий расчёт — это и есть та проверка, которой мы требовали после
  // неизвестного исхода: человек только что увидел настоящий баланс и лимит.
  purchaseOutcomeUnknown = false
  return { state: 'ok', quote }
}

// ── Докупка устройств: покупка ──────────────────────────────────────────────

// Намеренно НЕ async. Замок ставится ДО первого await, то есть до того, как
// запрос физически может уйти, и никакой будущий рефакторинг не вставит await
// выше проверки. Кнопка в интерфейсе гаснет по возврату 'busy', но гаснет она
// уже после того, как здесь решено: второе нажатие в сеть не пойдёт.
export function purchaseCabinetDevices(quoteId: string): Promise<CabinetDevicePurchaseResult> {
  if (purchaseInFlight) {
    return Promise.resolve<CabinetDevicePurchaseResult>({
      state: 'busy',
      message: t('error.devicePurchaseBusy')
    })
  }
  // Предыдущая попытка ушла в сеть и не вернулась. Деньги могли списаться.
  // Пока не пересчитают цену — не пускаем: это защита от второго списания.
  if (purchaseOutcomeUnknown) {
    return Promise.resolve<CabinetDevicePurchaseResult>({
      state: 'unknown',
      message: t('error.devicePurchaseUnknown')
    })
  }

  // Без сессии в сеть не идём и расчёт не тратим: интерфейсу здесь надо
  // предложить вход, а человеку — не терять подтверждение, которое он уже
  // прочитал.
  if (!getCabinetSession()) {
    return Promise.resolve<CabinetDevicePurchaseResult>({ state: 'unauthorized' })
  }

  const quote = lastQuote
  if (!quote || quote.id !== quoteId || Date.now() > quote.expiresAt) {
    return Promise.resolve<CabinetDevicePurchaseResult>({
      state: 'staleQuote',
      message: t('error.devicePurchaseStaleQuote')
    })
  }

  // Не хватает баланса — не отправляем вовсе. Причина не только в вежливости:
  // на отказе 402 сервер СОХРАНЯЕТ корзину, и следующее пополнение баланса
  // докупит устройства САМО, без нового подтверждения
  // (devices.py:484-491 → payment/common.py:422 →
  // auto_purchase_saved_cart_after_topup). Человек, который просто положил
  // денег, обнаружит списание, которого не ждал.
  if (!quote.enough) {
    return Promise.resolve<CabinetDevicePurchaseResult>({
      state: 'insufficient',
      requiredKopeks: quote.priceKopeks,
      balanceKopeks: quote.balanceKopeks,
      missingKopeks: quote.priceKopeks - quote.balanceKopeks,
      cartSaved: false
    })
  }

  // Расчёт одноразовый. Даже если замок выше как-то обойдут, второй вызов не
  // найдёт расчёта и получит staleQuote: две независимые защиты, а не одна.
  lastQuote = null
  purchaseInFlight = true
  return runDevicePurchase(quote)
    .catch((): CabinetDevicePurchaseResult => {
      // Сюда попадаем только на неожиданном исключении — а оно случается уже
      // после того, как запрос мог уйти. Значит исход неизвестен, и защёлку
      // надо поставить здесь тоже: иначе следующее нажатие спишет второй раз.
      purchaseOutcomeUnknown = true
      return { state: 'unknown', message: t('error.devicePurchaseUnknown') }
    })
    .finally(() => {
      purchaseInFlight = false
    })
}

async function runDevicePurchase(quote: CabinetDeviceQuote): Promise<CabinetDevicePurchaseResult> {
  let res: AxiosResponse
  try {
    // Число устройств берём ИЗ РАСЧЁТА, а не из аргумента вызова: покупается
    // ровно то, цену чего человек видел.
    res = await authorizedRequest('post', PATH_DEVICE_PURCHASE, {
      body: { devices: quote.devices }
    })
  } catch (e) {
    if (requestDefinitelyNotSent(e)) {
      return { state: 'network', message: t('error.connectNetwork') }
    }
    purchaseOutcomeUnknown = true
    return { state: 'unknown', message: t('error.devicePurchaseUnknown') }
  }

  if (res.status !== 200) return purchaseFailure(res)

  const body = objectBody(res)
  // 200 не тем телом на покупке — это НЕ «не смогли прочитать». Списание к
  // этому моменту уже произошло, а что ответило вместо кабинета — неизвестно.
  // Поэтому 'unknown', а не badResponse: badResponse звучит как «ничего не
  // случилось, повторите», и повтор здесь спишет второй раз.
  if (!body || body.success !== true) {
    purchaseOutcomeUnknown = true
    return { state: 'unknown', message: t('error.devicePurchaseUnknown') }
  }

  const newLimit = numberOf(body.new_device_limit)
  const chargedKopeks = numberOf(body.price_kopeks)
  const balanceKopeks = numberOf(body.balance_kopeks)
  // Сервер отвечает состоянием ПОСЛЕ списания — это авторитетнее нашего
  // расчёта. Если он его не назвал, покупка прошла, но во что превратились
  // лимит и баланс, мы не знаем: обещать цифры из расчёта нельзя.
  if (newLimit === undefined || chargedKopeks === undefined || balanceKopeks === undefined) {
    purchaseOutcomeUnknown = true
    return { state: 'unknown', message: t('error.devicePurchaseUnknown') }
  }

  return {
    state: 'ok',
    devicesAdded: numberOf(body.devices_added) ?? quote.devices,
    newLimit,
    chargedKopeks,
    chargedLabel: typeof body.price_label === 'string' ? body.price_label : '',
    balanceKopeks,
    // Сервер мог списать не ту сумму, что назвал расчёт: остаток дней и скидка
    // считаются заново на его стороне, и клиент это НЕ ограничивает никак.
    // Расхождение — повод сказать о нём человеку, а не прятать.
    quotedKopeks: quote.priceKopeks
  }
}

// Разбор отказа покупки. Отдельно от cabinetFailure, потому что здесь каждый
// код — это утверждение про деньги, и оно проверено по коду сервера.
function purchaseFailure(res: AxiosResponse): CabinetDevicePurchaseResult {
  const detail = detailOf(res.data)
  const record = detailRecord(res.data)

  // 402 — не хватило баланса. Списания не было (проверка идёт до
  // subtract_user_balance), но сервер сохранил корзину: следующее пополнение
  // докупит устройства само. Об этом человеку сказать обязательно.
  if (res.status === 402) {
    const required = numberOf(record?.required_kopeks)
    const current = numberOf(record?.current_kopeks)
    return {
      state: 'insufficient',
      requiredKopeks: required,
      balanceKopeks: current,
      missingKopeks:
        numberOf(record?.missing_kopeks) ??
        (required !== undefined && current !== undefined ? required - current : undefined),
      cartSaved: record?.cart_saved === true
    }
  }

  // 409 — пока шла покупка, кто-то ещё добрал устройства и лимит вышел за
  // максимум. Сервер списал и вернул деньги сам (devices.py:541-542).
  if (res.status === 409) {
    return {
      state: 'limitReached',
      refunded: true,
      message: reasonMessage(res, 'error.deviceLimitReached')
    }
  }

  // 400 про максимум устройств — отказ ДО списания. Различаем по русскому
  // тексту сервера; если текст изменят, попадём в 'rejected' ниже — тоже
  // корректный и безопасный ответ, просто менее точный.
  if (res.status === 400 && detail.includes('Максимальное количество устройств')) {
    return {
      state: 'limitReached',
      refunded: false,
      message: reasonMessage(res, 'error.deviceLimitReached')
    }
  }

  // ⚠️ Самое важное отличие покупки от остальных вызовов. Обработчик покупки
  // обёрнут в один try/except Exception → 500 (devices.py:644-651), и этот
  // except накрывает в том числе код ПОСЛЕ subtract_user_balance, который
  // коммитит списание сам. То есть 500 здесь значит «деньги могли уйти, а
  // устройства не прибавиться» — это 'unknown', а не «ошибка сервера,
  // повторите». Так же трактуем 502/504 и 503 без признака обслуживания: их
  // мог отдать прокси уже после того, как кабинет всё выполнил.
  if (res.status >= 500 && !(res.status === 503 && detailCode(res.data) === 'maintenance')) {
    purchaseOutcomeUnknown = true
    return { state: 'unknown', message: t('error.devicePurchaseUnknown') }
  }

  // Остальное — отказы до списания: 401/403/404/400/422/429 и 503-обслуживание.
  // Все 400 в обработчике покупки подняты раньше subtract_user_balance, так что
  // «денег не тронули» здесь — факт, а не надежда.
  return (
    cabinetFailure(res) ?? {
      state: 'unexpected',
      message: withStatus('error.cabinetUnexpected', res.status)
    }
  )
}

// ── Переименование и отключение одного устройства ───────────────────────────

// ⚠️ Пустой hwid — не мелочь. Адрес отключения одного устройства собирается как
// `/cabinet/subscription/devices/<hwid>`; при пустом hwid он схлопывается в
// `/cabinet/subscription/devices`, а DELETE по этому адресу — это «ОТКЛЮЧИТЬ
// ВСЕ УСТРОЙСТВА». Поэтому проверка стоит до сборки любого адреса и общая для
// обеих операций, а не рядом с каждой.
//
// Пустой hwid реален: кабинет берёт первое из hwid/deviceId/id, и если панель
// не дала ни одного — придёт null, а mapDevice честно превращает это в ''.
//
// Возвращает hwid, годный для адреса, или null. Кодирование оставлено месту
// сборки адреса: hwid приходит из панели, и встречается в нём что угодно,
// включая слэши, которые без кодирования добавят в путь лишний сегмент.
function usableHwid(hwid: unknown): string | null {
  if (typeof hwid !== 'string') return null
  const trimmed = hwid.trim()
  return trimmed || null
}

// Одна операция на устройство за раз. Денег это не стоит, но двойной DELETE
// превращается в пугающую ошибку панели, а двойной PATCH — в гонку двух имён.
const deviceOpsInFlight = new Set<string>()

async function deviceOp<T>(
  key: string,
  run: () => Promise<T>
): Promise<T | { state: 'busy'; message: string }> {
  if (deviceOpsInFlight.has(key)) return { state: 'busy', message: t('error.deviceOpBusy') }
  deviceOpsInFlight.add(key)
  try {
    return await run()
  } finally {
    deviceOpsInFlight.delete(key)
  }
}

// Имя нормализуем так же, как сервер (normalize_alias): схлопываем пробелы и
// режем по 64 символам. Иначе человек введёт длинное имя, сервер молча обрежет
// его, и на экране окажется не то, что сохранено.
function normalizeDeviceName(name: unknown): string {
  if (typeof name !== 'string') return ''
  const collapsed = name.split(/\s+/).filter(Boolean).join(' ')
  // Режем по кодовым точкам, а не по slice: у JS строка из пар UTF-16, и
  // обычный slice разрубит эмодзи ровно на границе, отправив на сервер
  // половину символа. Python на сервере считает символы, а не пары.
  return Array.from(collapsed).slice(0, DEVICE_NAME_MAX_LENGTH).join('')
}

// Переименование устройства. Пустое имя СБРАСЫВАЕТ своё название: сервер удаляет
// алиас и отвечает local_name: null, после чего в списке снова появится подпись
// от платформы и модели.
export function renameCabinetDevice(
  hwid: string,
  name: string
): Promise<CabinetDeviceRenameResult> {
  const id = usableHwid(hwid)
  if (!id) {
    return Promise.resolve<CabinetDeviceRenameResult>({
      state: 'badHwid',
      message: t('error.deviceNoHwid')
    })
  }
  return deviceOp(`rename:${id}`, () => runRenameDevice(id, normalizeDeviceName(name)))
}

async function runRenameDevice(hwid: string, name: string): Promise<CabinetDeviceRenameResult> {
  if (!getCabinetSession()) return { state: 'unauthorized' }

  let res: AxiosResponse
  try {
    const path = `/cabinet/subscription/devices/${encodeURIComponent(hwid)}/name`
    res = await authorizedRequest('patch', path, {
      // null, а не '': сервер принимает оба как сброс, но null — это то, что
      // объявлено в DeviceRenameRequest, и по нему видно намерение.
      body: { name: name || null }
    })
  } catch {
    return { state: 'network', message: t('error.connectNetwork') }
  }

  if (res.status === 404 && detailOf(res.data) === 'Device not found on your account') {
    // Устройство исчезло из панели, пока человек смотрел на список. Своё
    // состояние: интерфейсу надо обновить список, а не звать в поддержку.
    return { state: 'gone', message: t('error.deviceGone') }
  }
  const failure = cabinetFailure(res)
  if (failure) return failure
  const body = objectBody(res)
  if (!body) return badResponse(res)

  // local_name возвращается уже нормализованным сервером — берём его, а не своё
  // предположение: на экране должно стоять сохранённое.
  return {
    state: 'ok',
    hwid: typeof body.hwid === 'string' ? body.hwid : '',
    localName: optionalText(body.local_name)
  }
}

// Отключение ОДНОГО устройства. Денег не стоит и не возвращает: лимит подписки
// не меняется, освобождается только слот.
export function removeCabinetDevice(hwid: string): Promise<CabinetDeviceRemoveResult> {
  const id = usableHwid(hwid)
  if (!id) {
    return Promise.resolve<CabinetDeviceRemoveResult>({
      state: 'badHwid',
      message: t('error.deviceNoHwid')
    })
  }
  return deviceOp(`remove:${id}`, () => runRemoveDevice(id))
}

async function runRemoveDevice(hwid: string): Promise<CabinetDeviceRemoveResult> {
  if (!getCabinetSession()) return { state: 'unauthorized' }

  let res: AxiosResponse
  try {
    const path = `/cabinet/subscription/devices/${encodeURIComponent(hwid)}`
    res = await authorizedRequest('delete', path)
  } catch {
    return { state: 'network', message: t('error.connectNetwork') }
  }

  // 500 'Failed to delete device' — панель не подтвердила удаление. Денег это
  // не касается и повтор безопасен, поэтому обычная ошибка сервера с понятным
  // текстом, а не пугающее «исход неизвестен».
  const failure = cabinetFailure(res)
  if (failure) return failure

  const body = objectBody(res)
  if (!body || body.success !== true) return badResponse(res)

  return {
    state: 'ok',
    hwid: typeof body.deleted_hwid === 'string' ? body.deleted_hwid : hwid
  }
}
