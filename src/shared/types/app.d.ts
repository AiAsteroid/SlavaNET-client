interface AppVersion {
  version: string
  changelog: string
}

interface ISysProxyConfig {
  enable: boolean
  host?: string
  mode?: SysProxyMode
  bypass?: string[]
  pacScript?: string
  settingMode?: 'exec' | 'service'
}

interface IHost {
  domain: string
  value: string | string[]
}

interface AppConfig {
  core: 'mihomo' | 'mihomo-alpha' | 'system'
  systemCorePath?: string
  corePermissionMode?: 'elevated' | 'service'
  elevationDeclined?: boolean
  serviceAuthKey?: string
  disableLoopbackDetector: boolean
  disableEmbedCA: boolean
  disableSystemCA: boolean
  disableNftables: boolean
  safePaths: string[]
  proxyDisplayOrder: 'default' | 'delay' | 'name'
  proxyDisplayLayout: 'hidden' | 'single' | 'double'
  groupDisplayLayout: 'hidden' | 'single' | 'double'
  profileDisplayDate?: 'expire' | 'update'
  envType?: ('bash' | 'cmd' | 'powershell' | 'nushell')[]
  proxyCols: 'auto' | '1' | '2' | '3' | '4'
  connectionDirection: 'asc' | 'desc'
  connectionOrderBy: 'time' | 'upload' | 'download' | 'uploadSpeed' | 'downloadSpeed' | 'process'
  connectionListMode?: 'classic' | 'process'
  connectionViewMode?: 'list' | 'table'
  connectionTableColumns?: string[]
  connectionTableColumnWidths?: Record<string, number>
  connectionTableSortColumn?: string
  connectionTableSortDirection?: 'asc' | 'desc'
  connectionInterval?: number
  spinFloatingIcon?: boolean
  disableTray?: boolean
  showFloatingWindow?: boolean
  connectionCardStatus?: CardStatus
  dnsCardStatus?: CardStatus
  logCardStatus?: CardStatus
  pauseSSID?: string[]
  mihomoCoreCardStatus?: CardStatus
  profileCardStatus?: CardStatus
  proxyCardStatus?: CardStatus
  resourceCardStatus?: CardStatus
  ruleCardStatus?: CardStatus
  sniffCardStatus?: CardStatus
  sysproxyCardStatus?: CardStatus
  tunCardStatus?: CardStatus
  homeCardStatus?: CardStatus
  autoLightweight?: boolean
  autoLightweightDelay?: number
  autoLightweightMode?: 'core' | 'tray'
  mihomoCpuPriority?: Priority
  diffWorkDir?: boolean
  autoSetDNSMode?: 'none' | 'exec' | 'service'
  originDNS?: string
  useWindowFrame: boolean
  proxyInTray: boolean
  appTheme: AppTheme
  customTheme?: string
  autoCheckUpdate: boolean
  silentStart: boolean
  autoCloseConnection: boolean
  expandProxyGroups?: boolean
  sysProxy: ISysProxyConfig
  proxyMode: boolean
  maxLogDays: number
  userAgent?: string
  delayTestConcurrency?: number
  delayTestUrl?: string
  delayTestTimeout?: number
  encryptedPassword?: number[]
  controlDns?: boolean
  controlSniff?: boolean
  controlTun?: boolean
  useDockIcon?: boolean
  useCustomTrayMenu?: boolean
  hosts: IHost[]
  showWindowShortcut?: string
  showFloatingWindowShortcut?: string
  triggerSysProxyShortcut?: string
  triggerTunShortcut?: string
  ruleModeShortcut?: string
  globalModeShortcut?: string
  directModeShortcut?: string
  restartAppShortcut?: string
  quitWithoutCoreShortcut?: string
  onlyActiveDevice?: boolean
  networkDetection?: boolean
  networkDetectionBypass?: string[]
  networkDetectionInterval?: number
  displayIcon?: boolean
  displayAppName?: boolean
  disableGPU: boolean
  mainSwitchMode?: 'tun' | 'sysproxy'
  useHotReloadProfile?: boolean
  showTour?: boolean
}

interface ProfileConfig {
  current?: string
  items: ProfileItem[]
}

interface ProfileItem {
  id: string
  type: 'remote' | 'local'
  name: string
  url?: string // remote
  ua?: string // remote
  file?: string // local
  verify?: boolean // remote
  interval?: number
  home?: string
  homeName?: string
  updated?: number
  useProxy?: boolean
  extra?: SubscriptionUserInfo
  locked?: boolean
  autoUpdate?: boolean
  announce?: string
  logo?: string
  supportUrl?: string
  globalMode?: boolean
  expandProxyGroups?: boolean
  customCss?: string
}

interface SubscriptionUserInfo {
  upload: number
  download: number
  total: number
  expire: number
}

type ConnectStatus = 'requesting' | 'waiting' | 'fetching' | 'importing' | 'done' | 'failed'

// Where the person is sent to confirm the sign-in. Both routes use the same
// one-time token and the same poll; only the destination differs.
type ConnectRoute = 'telegram' | 'website'

interface ConnectStatusEvent {
  status: ConnectStatus
  message?: string
  // Confirmation link, so the screen can offer it again if the browser or
  // Telegram swallowed it
  link?: string
  via?: ConnectRoute
  // First 8 characters of the request token. The confirmation page shows the
  // same ones, so the person can tell their own request from a token somebody
  // else pushed at them.
  code?: string
}

// Одно устройство, подключённое к подписке. Приходит из кабинета
// (GET /cabinet/subscription/devices), тот берёт данные из панели.
// Времена — миллисекунды, как и остальные даты в приложении; undefined значит
// «панель этого не дала», а не «давно».
interface CabinetDevice {
  // Может быть пустым: панель не всегда даёт идентификатор. Ключ для списка в
  // этом случае придётся брать от индекса.
  hwid: string
  // Кабинет подставляет 'Unknown', когда панель молчит; пустая строка —
  // когда поля не было вовсе.
  platform: string
  model: string
  // Имя, которое человек задал устройству сам, в кабинете или в боте.
  localName?: string
  // Приложение и версия из User-Agent, уже разобранные кабинетом:
  // «SlavaNET 1.4», «Streisand 2.1».
  app?: string
  osVersion?: string
  lastSeenAt?: number
  firstSeenAt?: number
}

// Результат запроса устройств. Состояния разделены намеренно: пустой список —
// это НЕ отказ, а отсутствие сессии — не пустой список.
//   ok             — список получен; devices может быть пустым, и это нормально
//                    (устройств ещё нет ИЛИ панель не ответила кабинету —
//                    различить по ответу нельзя, текст должен быть сдержанным)
//   unauthorized   — сессии нет или кабинет её не принял: предложить вход,
//                    а не «устройств нет»
//   noSubscription — у аккаунта нет подписки
//   error          — спросить не удалось (сеть, 5xx, лимит запросов);
//                    message готов к показу, повтор имеет смысл
// limit отсутствует, когда лимит не задан: в ответе это device_limit = 0,
// которое НЕ значит «ноль устройств».
type CabinetDevicesResult =
  | { state: 'ok'; devices: CabinetDevice[]; total: number; limit?: number }
  | { state: 'unauthorized' }
  | { state: 'noSubscription' }
  | { state: 'error'; message: string }

// ── Кабинет: общие состояния отказа ─────────────────────────────────────────
// Один союз на все вызовы кабинета, кроме списка устройств: тот оставлен как
// был (CabinetDevicesResult выше), чтобы не переписывать чужой экран подписки.
// Свести их в один — отдельная задача после интеграции.
//
// Состояния разделены не ради полноты, а потому что интерфейсу нужны разные
// кнопки: «войти», «купить подписку», «обновить список», «подождать»,
// «повторить», «написать в поддержку». Один текст ошибки на всё — это кнопка
// «повторить» там, где повтор никогда не поможет.
//
// message готов к показу человеку. У unauthorized и noSubscription его нет
// намеренно: это не сообщения, а развилки — интерфейс обязан показать вход или
// предложение купить подписку, а не строку с текстом.
type CabinetFailure =
  // Сессии нет, либо кабинет не принял её ПОСЛЕ одного обновления токена.
  // Сессия при этом не стирается: hasCabinetSession() может отвечать true.
  | { state: 'unauthorized' }
  // У аккаунта нет подписки. Приходит и 404, и 400 — различено по detail.
  | { state: 'noSubscription' }
  // Сервер не нашёл объект запроса (не подписку). Кабинет постарше без нужной
  // ручки выглядит так же.
  | { state: 'notFound'; message: string }
  // 403: аккаунт заблокирован, удалён, либо покупки для него отключены.
  // Повтор не поможет — только поддержка.
  | { state: 'forbidden'; message: string }
  // Сервер отказал по названной им причине (подписка неактивна, докупка
  // выключена, неверные параметры). Денег такой отказ не касается.
  | { state: 'rejected'; message: string }
  // 409: состояние изменилось между чтением и записью. Надо перечитать данные.
  | { state: 'conflict'; message: string }
  // 429. На маршрутах устройств и баланса лимитера в приложении нет — значит
  // ограничил прокси. Лечится ожиданием.
  | { state: 'rateLimited'; message: string }
  // 503 с признаком обслуживания. Обработчик не запускался.
  | { state: 'maintenance'; message: string }
  // 200 с телом не того вида: чаще всего ответил не кабинет, а страница ошибки
  // прокси. НЕ «данных нет» — данные неизвестны.
  | { state: 'badResponse'; message: string }
  // 5xx. Для покупки такого состояния НЕ бывает: там 5xx означает «деньги
  // могли уйти» и приходит как 'unknown'.
  | { state: 'serverError'; message: string }
  // Сети нет или запрос не дошёл.
  | { state: 'network'; message: string }
  // Код состояния, которого мы не ждали. Отдельно от serverError, чтобы в
  // поддержке было видно: это не «сервер упал», это что-то незнакомое.
  | { state: 'unexpected'; message: string }

// ── Кабинет: баланс ─────────────────────────────────────────────────────────
// Всё в копейках, как на сервере. Рубли не заводим: balance_rubles в ответе
// приходит числом с плавающей точкой, и складывать деньги в нём нельзя.
type CabinetBalanceResult = { state: 'ok'; balanceKopeks: number } | CabinetFailure

// ── Кабинет: история операций ───────────────────────────────────────────────
interface CabinetTransaction {
  id: number
  // Тип операции строкой сервера: deposit, subscription_payment,
  // referral_reward, withdrawal, refund… Список не закрыт, поэтому string.
  type: string
  // Знак уже расставлен сервером: списания отрицательные. Своей логики знаков
  // в клиенте нет намеренно — две реализации разойдутся.
  amountKopeks: number
  description?: string
  paymentMethod?: string
  // false — платёж создан, но не завершён. Такую сумму нельзя показывать как
  // уже прошедшую.
  completed: boolean
  createdAt?: number
  completedAt?: number
}

interface CabinetTransactionsParams {
  // Нумерация с единицы. Сервер принимает page ≥ 1, per_page 1..100 —
  // за границами отдаёт 422, поэтому значения зажимаются в клиенте.
  page?: number
  perPage?: number
  // Фильтр по типу операции, как он приходит в CabinetTransaction.type.
  type?: string
}

type CabinetTransactionsResult =
  | {
      state: 'ok'
      items: CabinetTransaction[]
      // Сколько записей страницы прочитать не удалось (без id или суммы).
      // Больше нуля — в истории денег дыра, и об этом надо сказать, а не
      // молча показать список короче.
      skipped: number
      total: number
      page: number
      perPage: number
      pages: number
    }
  | CabinetFailure

// ── Кабинет: докупка устройств ──────────────────────────────────────────────
// ⚠️ ДЕНЬГИ. POST /cabinet/subscription/devices/purchase списывает с баланса
// мгновенно: подтверждения на сервере нет, отката нет, маршрута возврата в
// пользовательском API не существует. Цена прорейчена по ВСЕМУ остатку
// подписки, поэтому при большом остатке одно устройство стоит много месячных
// цен. Расчёт ниже — обязательный шаг перед покупкой, а не удобство.
interface CabinetDeviceQuote {
  // Идентификатор расчёта. Покупка принимает ТОЛЬКО его: числа устройств она не
  // принимает вовсе, поэтому «посчитали за одно, купили пять» невозможно.
  id: string
  devices: number
  // Сумма, которую сервер назвал ПРЯМО СЕЙЧАС. ⚠️ Это прогноз, а не потолок:
  // сервер пересчитает цену в момент покупки и спишет свою. Клиент ограничить
  // её не может никак.
  priceKopeks: number
  // Как сумму подписал сам сервер («1 493 ₽»), с его округлением. Пустая
  // строка, если он подписи не дал.
  priceLabel: string
  balanceKopeks: number
  // Остаток после списания. Отрицательный — денег не хватает (enough=false).
  balanceAfterKopeks: number
  enough: boolean
  // ⚠️ Лимит из ручки цены (`device_limit or 1`); список устройств отдаёт
  // `device_limit or 0` и на незаданном лимите расходится на единицу.
  // В подтверждении показывай newLimit ИЗ РАСЧЁТА.
  currentLimit: number
  newLimit: number
  maxLimit?: number
  canAdd?: number
  // Остаток подписки в днях — по нему прорейтена цена. Это объяснение суммы:
  // без него «1 493 ₽ за устройство при цене 200 ₽/мес» выглядит ошибкой.
  daysLeft: number
  discountPercent?: number
  // Когда расчёт перестаёт годиться. После этого момента покупка вернёт
  // staleQuote: остаток дней уменьшается каждые сутки, и вчерашняя цифра — ложь.
  expiresAt: number
}

type CabinetDeviceQuoteResult =
  | { state: 'ok'; quote: CabinetDeviceQuote }
  // Сервер сообщает «нельзя» ответом 200 с available:false и своей причиной:
  // нет активной подписки, докупка выключена, достигнут максимум, «можно
  // добавить максимум N». Это НЕ ошибка — это отказ продавать.
  | {
      state: 'unavailable'
      reason: string
      currentLimit?: number
      maxLimit?: number
      canAdd?: number
    }
  | CabinetFailure

type CabinetDevicePurchaseResult =
  // Списание прошло. Числа — из ответа сервера, то есть состояние ПОСЛЕ
  // списания; свой расчёт для показа итога не используется.
  | {
      state: 'ok'
      devicesAdded: number
      newLimit: number
      chargedKopeks: number
      chargedLabel: string
      balanceKopeks: number
      // Сколько называл расчёт. Расхождение с chargedKopeks возможно (сервер
      // пересчитывает остаток дней и скидку сам) и его надо показать, а не
      // спрятать.
      quotedKopeks: number
    }
  // Запрос по этой операции уже в полёте. В сеть НИЧЕГО не ушло.
  | { state: 'busy'; message: string }
  // Расчёта нет, он не тот или истёк. Надо запросить цену заново и показать
  // подтверждение снова. В сеть ничего не ушло.
  | { state: 'staleQuote'; message: string }
  // Денег не хватает. Числа могут отсутствовать, если отказ пришёл от сервера
  // без подробностей.
  // ⚠️ cartSaved=true означает, что сервер сохранил корзину и СЛЕДУЮЩЕЕ
  // пополнение баланса докупит устройства САМО, без нового подтверждения.
  // Об этом надо сказать прямо. Клиент до 402 обычно не доводит (проверяет
  // баланс по расчёту), но при гонке отказ придёт именно так.
  | {
      state: 'insufficient'
      requiredKopeks?: number
      balanceKopeks?: number
      missingKopeks?: number
      cartSaved: boolean
    }
  // Максимум устройств. refunded=true — сервер успел списать и вернул сам
  // (это 409); refunded=false — отказал до списания.
  | { state: 'limitReached'; refunded: boolean; message: string }
  // ⚠️ Самое важное состояние. Запрос ушёл, ответа нет (таймаут, обрыв, 5xx,
  // 200 непонятным телом). Деньги МОГЛИ списаться, а устройства могли не
  // прибавиться: обработчик покупки коммитит списание отдельно от увеличения
  // лимита. Повторять НЕЛЬЗЯ. Пока не запросят цену заново, покупка будет
  // возвращать это же состояние — так устроено специально.
  | { state: 'unknown'; message: string }
  | CabinetFailure

// ── Кабинет: имя и отключение устройства ────────────────────────────────────
type CabinetDeviceRenameResult =
  // localName отсутствует, когда имя сброшено: в списке снова появится подпись
  // от платформы и модели.
  | { state: 'ok'; hwid: string; localName?: string }
  // У устройства нет идентификатора (панель его не дала). Управлять им нельзя.
  // ⚠️ Проверка обязательна: пустой hwid в адресе отключения схлопывает его в
  // маршрут «отключить ВСЕ устройства».
  | { state: 'badHwid'; message: string }
  // Устройство уже исчезло из панели, пока человек смотрел на список.
  | { state: 'gone'; message: string }
  | { state: 'busy'; message: string }
  | CabinetFailure

type CabinetDeviceRemoveResult =
  | { state: 'ok'; hwid: string }
  | { state: 'badHwid'; message: string }
  | { state: 'busy'; message: string }
  | CabinetFailure
