import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  AppWindow,
  ChevronRight,
  CircleAlert,
  CreditCard,
  HeadsetIcon,
  InfinityIcon,
  Laptop,
  LogIn,
  LogOut,
  Minus,
  MonitorSmartphone,
  Plus,
  RefreshCcw,
  Smartphone,
  Wallet
} from 'lucide-react'
import TitleStrip from '@renderer/components/shell/title-strip'
import { Group, Row } from '@renderer/components/shell/list-group'
import SubscriptionEmptyState from '@renderer/components/profiles/subscription-empty-state'
import ConfirmModal from '@renderer/components/base/base-confirm'
import DeviceSheet from '@renderer/components/cabinet/device-sheet'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Spinner } from '@renderer/components/ui/spinner'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { useLoginStore } from '@renderer/store/login-store'
import { calcTraffic } from '@renderer/utils/calc'
import {
  disconnectAccount,
  fetchCabinetBalance,
  fetchCabinetDeviceQuote,
  fetchCabinetDevices,
  fetchCabinetTransactions,
  hasCabinetSession,
  purchaseCabinetDevices,
  removeCabinetDevice,
  renameCabinetDevice
} from '@renderer/utils/ipc'
import { CABINET_URL, providerPage, splitTariffName } from '@renderer/utils/subscription'
import { cn } from '@renderer/lib/utils'

// Порог тревоги тот же, что у живой строки на главной (home.tsx:196): два экрана
// об одной подписке не имеют права расходиться в том, что считать «кончается».
const EXPIRY_WARNING_DAYS = 3

// Зоны расхода трафика. 75/90 — те же пороги, что у полосы в кабинете
// (TrafficProgressBar.tsx:36-45); в клиенте раньше стояло 70/90, и человек,
// смотревший на кабинет и на клиент, видел разный цвет на одном числе.
const TRAFFIC_WARN_SHARE = 75
const TRAFFIC_LOW_SHARE = 90

// Сколько ответ кабинета об устройствах считается свежим.
const DEVICES_TTL_MS = 60_000

// Баланс живёт вдвое короче списка устройств: деньги меняются чаще железа, и
// цифра, которой минута, на экране кошелька уже неприятна.
const WALLET_TTL_MS = 30_000

// Пауза перед запросом цены после щелчка по счётчику. Каждый расчёт — ДВА
// запроса в кабинет (цена и баланс, connect.ts:1083), и «плюс-плюс-плюс» без
// паузы отправил бы три пары подряд. Пока пауза идёт, цена на экране не
// показывается вовсе — не бывает состояния «старая цена рядом с новым числом».
const PRICE_DEBOUNCE_MS = 350

// Верхняя граница счётчика в интерфейсе. Сервер и главный процесс принимают до
// 100 (MAX_DEVICES_PER_PURCHASE, connect.ts:771), но цена прорейтится по ВСЕМУ
// остатку подписки: при 224 днях остатка одно устройство стоит семь с половиной
// месячных цен. Счётчик, доезжающий до ста, в окне 460 px — это ловушка, а не
// возможность; кому нужно больше десяти слотов, тот идёт в кабинет.
const MAX_DEVICES_PER_STEP = 10

// Кэш живёт на МОДУЛЕ, а не в состоянии компонента: маршрут /subscription
// отдаёт отдельный элемент (routes/index.tsx:79), и при уходе на другую вкладку
// капсулы страница размонтируется вместе со всем своим состоянием. Без
// модульного кэша каждое возвращение на вкладку — новый запрос в кабинет с
// bearer-токеном, а туда-сюда по капсуле человек ходит постоянно.
//
// В ключе лежит id профиля и его `updated`: после входа в аккаунт или обновления
// подписки профиль переимпортируется и `updated` меняется — а вместе с ним
// меняется и ответ об устройствах (клиент только что зарегистрировался сам,
// сессия появилась). Поэтому такой кэш обязан протухнуть сразу, не дожидаясь
// минуты, иначе после входа в списке ещё минуту будет висеть «нужен вход».
let devicesCache: { key: string; at: number; result: CabinetDevicesResult } | null = null

// Снимок кошелька: баланс и последняя операция. Лежат вместе, потому что
// показываются одной карточкой и запрашиваются одним заходом.
interface WalletSnapshot {
  balance: CabinetBalanceResult
  lastTx: CabinetTransactionsResult
}

// ⚠️ Кэш кошелька намеренно ключуется тем же ключом, что устройства (профиль +
// его `updated`). Баланс не свойство подписки, но меняется ключ ровно тогда,
// когда сменился аккаунт, — а это единственный случай, когда старую цифру
// нельзя показывать даже секунду.
let walletCache: { key: string; at: number; snapshot: WalletSnapshot } | null = null

// Человек ушёл пополнять баланс в браузер. Флаг на МОДУЛЕ, а не в ref: пока
// браузер открыт, человек может переключить вкладку капсулы, экран
// размонтируется вместе со всеми ref, и возвращение показало бы старую цифру.
let topUpPending = false

// ⚠️ ДЕНЬГИ. Прошлая покупка ушла и не вернулась: списание могло произойти.
// Флаг на МОДУЛЕ по той же причине, что и предыдущий, только цена ошибки выше:
// переключение вкладки капсулы не имеет права стереть предупреждение о том, что
// деньги, возможно, уже списаны. Сама защита от второго списания стоит в
// главном процессе (purchaseOutcomeUnknown, connect.ts:1053) и переживает
// размонтирование экрана — здесь живёт только её объяснение человеку, и жить
// оно обязано столько же.
let purchaseOutcomeUnknown = false

// Куда ведём пополнять. Это корень кабинета, а не выдуманный /balance: своей
// страницы пополнения у кабинета в клиенте не зафиксировано, а промах по
// несуществующему пути даёт человеку 404 вместо формы оплаты. Корень кабинета
// проверен — им же открывается «Личный кабинет» ниже и форма входа
// (cabinet-login-modal.tsx:81).
const TOPUP_URL = CABINET_URL

// Иконка по платформе. Строка приходит из панели как есть, поэтому сверяем по
// подстроке, а не по равенству: там бывает и 'iOS', и 'iPhone OS 18.1', и
// подставленное кабинетом 'Unknown'.
function deviceIcon(platform: string): typeof Laptop {
  const value = platform.toLowerCase()
  if (/ios|iphone|ipad|android|harmony/.test(value)) return Smartphone
  if (/mac|darwin|win|linux|ubuntu|debian/.test(value)) return Laptop
  return MonitorSmartphone
}

// 'Unknown' — это заглушка, которую подставляет сам кабинет, когда панель не
// дала поля. Показывать её как имя устройства или как название платформы нельзя:
// это не ответ, а его отсутствие, и у нас на такой случай есть свои слова.
function isBlank(value?: string): boolean {
  const raw = (value ?? '').trim()
  return raw === '' || raw.toLowerCase() === 'unknown'
}

// Группировка разрядов у целого числа рублей. Intl зовём ТОЛЬКО для пробелов:
// сами деньги считаем целыми копейками, потому что копейки в рублях — это
// float, а складывать и вычитать деньги во float нельзя.
const RUBLE_GROUPS = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })

/**
 * Копейки → «1 493 ₽». Рубли и копейки получаем делением с остатком, без
 * единого деления на 100 в плавающей точке.
 *
 * ⚠️ НЕ подставляет ноль на нечисло. «0 ₽» в подтверждении покупки — это
 * разрешение списать любую сумму, поэтому нечисло честно превращается в тире, а
 * вызывающий код обязан до такого не доводить (см. quoteIsSane).
 */
function formatKopeks(kopeks?: number): string {
  if (kopeks === undefined || !Number.isFinite(kopeks)) return '—'
  const value = Math.trunc(kopeks)
  // Минус, а не дефис: в «−1 493 ₽» дефис визуально сливается с цифрой.
  const sign = value < 0 ? '\u2212' : ''
  const abs = Math.abs(value)
  const kop = abs % 100
  const tail = kop > 0 ? `,${String(kop).padStart(2, '0')}` : ''
  // Неразрывный пробел перед знаком рубля: сумма не имеет права переноситься
  // так, чтобы «₽» оказался на следующей строке, а число — без валюты.
  return `${sign}${RUBLE_GROUPS.format(Math.floor(abs / 100))}${tail}\u00A0₽`
}

// То же, но со знаком плюса у поступлений: в строке истории «+500 ₽» и «−1 493 ₽»
// различаются с одного взгляда, а «500 ₽» и «−1 493 ₽» — нет.
// ⚠️ Знак суммы расставляет СЕРВЕР (списания приходят отрицательными), своей
// логики знаков в клиенте нет: две реализации разойдутся.
function formatSignedKopeks(kopeks: number): string {
  if (!Number.isFinite(kopeks)) return '—'
  return kopeks > 0 ? `+${formatKopeks(kopeks)}` : formatKopeks(kopeks)
}

// Название операции для тех типов, которые сервер называет машинным словом.
// Список не закрыт (CabinetTransaction.type — string), поэтому незнакомый тип
// уходит в «Операция», а не показывается как `subscription_payment`.
const TX_LABEL_KEYS: Record<string, string> = {
  deposit: 'pages.subscription.wallet.opDeposit',
  subscription_payment: 'pages.subscription.wallet.opSubscription',
  referral_reward: 'pages.subscription.wallet.opReferral',
  refund: 'pages.subscription.wallet.opRefund',
  withdrawal: 'pages.subscription.wallet.opWithdrawal',
  gift_payment: 'pages.subscription.wallet.opGift',
  poll_reward: 'pages.subscription.wallet.opPoll'
}

// Что показывает блок цены. Одна переменная на всё состояние: «идёт запрос»,
// «есть цена» и «сервер отказался продавать» взаимно исключают друг друга, и на
// трёх флагах они рано или поздно оказались бы включены одновременно.
type PriceFailure =
  // Сервер ответил 200 и «продавать не буду», назвав причину по-русски. Это НЕ
  // ошибка связи: кнопка «повторить» тут не нужна.
  | { kind: 'unavailable'; reason: string }
  // Спросить не удалось. Повтор имеет смысл.
  | { kind: 'failed'; failure: CabinetFailure }
  // Ответ пришёл, но числам в нём верить нельзя. Отдельно от 'failed', потому
  // что повторять тут нечего — это не сеть, это непонятный ответ.
  | { kind: 'broken' }

// Разобранный ответ расчёта: цена есть либо её нет по названной причине.
// Отдельно от PriceView, потому что «ещё не спрашивали» и «спрашиваем» — это
// состояния ЭКРАНА, а не ответа. Без этого разделения поток подтверждения не
// может передать отказ дальше: в его тип пролезали бы idle и loading, которых
// разбор ответа не возвращает никогда.
type PriceResolved = { kind: 'ok'; quote: CabinetDeviceQuote } | PriceFailure

type PriceView =
  // Цену ещё не спрашивали. ⚠️ Это НАЧАЛЬНОЕ состояние, и цена сама не
  // подгружается — см. комментарий к askPrice.
  | { kind: 'idle' }
  | { kind: 'loading' }
  | PriceResolved

// Состояние подтверждения покупки. Диалог открыт, пока это не null.
type ConfirmState =
  // Пересчитываем цену. ⚠️ Обязательный шаг: показывать подтверждение по цене
  // из блока нельзя, остаток дней уменьшается каждые сутки.
  | { stage: 'quoting' }
  | { stage: 'ready'; quote: CabinetDeviceQuote; previousKopeks?: number }
  // Запрос ушёл. Закрыть диалог в этой фазе нельзя.
  | { stage: 'sending'; quote: CabinetDeviceQuote }
  | { stage: 'quoteFailed'; failure: PriceFailure }
  | { stage: 'done'; result: CabinetDevicePurchaseResult }

/**
 * Числа расчёта, на которые можно смотреть. Проверка не формальность: расчёт с
 * нечислом в цене — это подтверждение, в котором вместо суммы стоит тире, то
 * есть согласие непонятно на что.
 */
function quoteIsSane(quote: CabinetDeviceQuote, expectedDevices: number): boolean {
  return (
    quote.devices === expectedDevices &&
    Number.isFinite(quote.priceKopeks) &&
    Number.isFinite(quote.balanceKopeks) &&
    Number.isFinite(quote.balanceAfterKopeks) &&
    Number.isFinite(quote.newLimit) &&
    typeof quote.id === 'string' &&
    quote.id !== ''
  )
}

// Строка подтверждения: подпись слева, число справа. tabular-nums обязателен —
// четыре суммы в столбик пропорциональными цифрами читаются как числа разных
// порядков, и «останется 6 ₽» теряется рядом с «спишем 1 493 ₽».
const MoneyRow: React.FC<{ label: string; value: string; strong?: boolean }> = ({
  label,
  value,
  strong
}) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <span className="min-w-0 text-xs text-muted-foreground">{label}</span>
    <span
      className={cn(
        'shrink-0 tabular-nums',
        strong ? 'text-base font-semibold text-foreground' : 'text-sm text-foreground'
      )}
    >
      {value}
    </span>
  </div>
)

const Subscription: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { profileConfig, addProfileItem } = useProfileConfig()
  const openLogin = useLoginStore((s) => s.setOpen)
  const [updating, setUpdating] = useState(false)

  const currentProfile = useMemo(() => {
    if (!profileConfig?.current || !profileConfig?.items) return null
    return profileConfig.items.find((item) => item.id === profileConfig.current) ?? null
  }, [profileConfig])

  const hasProfiles = (profileConfig?.items?.length ?? 0) > 0

  const extra = currentProfile?.extra
  const total = extra?.total ?? 0
  const used = (extra?.upload ?? 0) + (extra?.download ?? 0)
  const unlimited = total <= 0
  const expireAt = extra?.expire ?? 0

  // Меру рисуем только для удалённой подписки, у которой сервер прислал
  // заголовок с цифрами. У локального конфига нет ни трафика, ни срока, и
  // «∞ Безлимит» на нём было бы прямой ложью, а не хорошей новостью.
  const hasMeter = currentProfile?.type === 'remote' && !!extra

  const { daysRemaining, isExpired } = useMemo(() => {
    if (expireAt <= 0) return { daysRemaining: 0, isExpired: false }
    const at = dayjs.unix(expireAt)
    return { daysRemaining: Math.max(0, at.diff(dayjs(), 'day')), isExpired: at.isBefore(dayjs()) }
  }, [expireAt])

  // Состояние карточки — ОДНА переменная, ровно как один класс на корне у
  // концепта. Ниже почти нет развилок по состоянию: цвет разъезжается через
  // локальные --sn-card и --sn-live, заданные тут же на корне. Перекрасить
  // карточку — поменять три строки здесь, а не двадцать классов по разметке.
  const cardState: 'ok' | 'warn' | 'expired' = isExpired
    ? 'expired'
    : expireAt > 0 && daysRemaining <= EXPIRY_WARNING_DAYS
      ? 'warn'
      : 'ok'

  // Доля считается только когда есть от чего считать. ⚠️ Это и есть починка
  // изъяна концепта: шкала там рисовалась и при безлимите, а полная полоса
  // читается как «трафик кончился» — при total <= 0 полосы просто нет.
  const usedShare = unlimited ? 0 : Math.min(100, Math.round((used / total) * 100))
  const shareColor =
    usedShare >= TRAFFIC_LOW_SHARE
      ? 'bg-destructive'
      : usedShare >= TRAFFIC_WARN_SHARE
        ? 'bg-warning'
        : 'bg-[color:var(--sn-accent)]'

  const { name, status } = splitTariffName(currentProfile?.name)
  // Знак — первая буква названия. Логотип, если он пришёл, ляжет поверх буквы,
  // поэтому битая ссылка просто открывает букву и не оставляет дыру.
  const initial = (name || 'S').trim().charAt(0).toUpperCase()

  // Чип состояния. При тревоге и истечении он свой, иначе — слово, которое
  // кабинет приклеил к названию тарифа («SlavaNET - Active»). Тот же набор, что
  // у живой строки на главной: один и тот же профиль обязан называться на двух
  // экранах одинаково.
  const stateChip = isExpired
    ? t('pages.more.subscription.expired')
    : cardState === 'warn'
      ? t('pages.home.statusExpiring')
      : status

  // Кабинет — всегда наш адрес. Заголовок profile-web-page-url для этого не
  // годится: панель кладёт туда ссылку подписки (см. providerPage).
  const cabinetUrl = CABINET_URL
  const providerUrl = providerPage(currentProfile ?? undefined)
  const supportUrl = currentProfile?.supportUrl
  const canUpdate = !!currentProfile && currentProfile.type === 'remote'

  // Куда вести из карточки, когда подписка кончается. Порядок тот же, что у
  // живой строки на главной (home.tsx:199): свой адрес кабинета, иначе
  // поддержка — оплатить через человека тоже способ.
  const renewAction =
    currentProfile?.homeName && providerUrl
      ? { url: providerUrl, label: currentProfile.homeName }
      : currentProfile?.supportUrl
        ? { url: currentProfile.supportUrl, label: t('pages.home.renewSubscription') }
        : null

  const onUpdate = async (): Promise<void> => {
    if (!currentProfile || updating) return
    setUpdating(true)
    try {
      await addProfileItem(currentProfile)
    } finally {
      setUpdating(false)
    }
  }

  // Ответ приходит после ухода с экрана постоянно: запрос идёт в сеть, а вкладку
  // переключают мгновенно. Без этого флага setState летел бы в размонтированный
  // компонент.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return (): void => {
      aliveRef.current = false
    }
  }, [])

  const devicesKey = `${currentProfile?.id ?? ''}:${currentProfile?.updated ?? 0}`

  // --- Подключённые устройства ---------------------------------------------

  const [devices, setDevices] = useState<CabinetDevicesResult | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)

  const loadDevices = useCallback(
    async (force: boolean): Promise<void> => {
      const cached = devicesCache
      if (
        !force &&
        cached &&
        cached.key === devicesKey &&
        Date.now() - cached.at < DEVICES_TTL_MS
      ) {
        // Свежий ответ уже есть — в сеть не идём вовсе, просто показываем его.
        setDevices(cached.result)
        return
      }
      setDevicesLoading(true)
      try {
        // По договору не бросает на «нет устройств» и «нужен вход» — это
        // состояния ответа. Бросить может только сам канал ipc, и это уже
        // «спросить не удалось», а не «устройств нет».
        const res = await fetchCabinetDevices()
        devicesCache = { key: devicesKey, at: Date.now(), result: res }
        if (aliveRef.current) setDevices(res)
      } catch {
        const res: CabinetDevicesResult = {
          state: 'error',
          message: t('pages.subscription.devices.error')
        }
        devicesCache = { key: devicesKey, at: Date.now(), result: res }
        if (aliveRef.current) setDevices(res)
      } finally {
        if (aliveRef.current) setDevicesLoading(false)
      }
    },
    [devicesKey, t]
  )

  const refreshDevices = useCallback((): void => {
    // Кэш обязан протухнуть ВСЕГДА, даже если экран уже размонтировали: иначе
    // возврат на вкладку ещё минуту покажет старое имя и старую занятость.
    devicesCache = null
    if (aliveRef.current) void loadDevices(true)
  }, [loadDevices])

  // --- Кошелёк --------------------------------------------------------------

  const [wallet, setWallet] = useState<WalletSnapshot | null>(null)
  const [walletLoading, setWalletLoading] = useState(false)

  const loadWallet = useCallback(
    async (force: boolean): Promise<void> => {
      // Человек уходил пополнять баланс в браузер — цифра на экране заведомо
      // устарела, сколько бы ей ни было секунд.
      const afterTopUp = topUpPending
      if (afterTopUp) topUpPending = false
      const fresh = force || afterTopUp

      const cached = walletCache
      if (
        !fresh &&
        cached &&
        cached.key === devicesKey &&
        Date.now() - cached.at < WALLET_TTL_MS
      ) {
        setWallet(cached.snapshot)
        return
      }
      setWalletLoading(true)
      // Параллельно можно: обе ручки только читают, денег не двигают, а два
      // одновременных 401 главный процесс сведёт в одно обновление токена
      // (refreshSessionShared) — именно для этого оно там и появилось.
      //
      // Отказ ловит КАЖДЫЙ вызов сам, а не один try вокруг обоих: если канал ipc
      // уронил историю, баланс всё равно пришёл, и терять его из-за соседа незачем.
      const [balance, lastTx] = await Promise.all([
        fetchCabinetBalance().catch(
          (): CabinetBalanceResult => ({ state: 'network', message: '' })
        ),
        fetchCabinetTransactions({ page: 1, perPage: 1 }).catch(
          (): CabinetTransactionsResult => ({ state: 'network', message: '' })
        )
      ])
      const snapshot: WalletSnapshot = { balance, lastTx }
      // Кэшируем и отказ: без этого переключение вкладок туда-сюда долбило бы
      // кабинет отказными запросами без всякой надежды на другой ответ.
      walletCache = { key: devicesKey, at: Date.now(), snapshot }
      if (aliveRef.current) {
        setWallet(snapshot)
        setWalletLoading(false)
      }
    },
    [devicesKey]
  )

  const refreshWallet = useCallback((): void => {
    walletCache = null
    if (aliveRef.current) void loadWallet(true)
  }, [loadWallet])

  // Пополнение — ТОЛЬКО в браузере. Оплату в приложении мы не принимаем
  // сознательно: платёжные формы кабинета живут своей жизнью, а в Electron их
  // пришлось бы держать в webview и отвечать за чужие редиректы.
  const openTopUp = useCallback((): void => {
    topUpPending = true
    window.open(TOPUP_URL)
  }, [])

  // Вернулись в приложение после браузера — перечитать баланс. Слушаем focus
  // окна, а не visibilitychange: у Electron-окна свёрнутость и потеря фокуса —
  // разные вещи, а нас интересует именно возвращение.
  useEffect(() => {
    const onFocus = (): void => {
      if (!topUpPending) return
      void loadWallet(false)
    }
    window.addEventListener('focus', onFocus)
    return (): void => {
      window.removeEventListener('focus', onFocus)
    }
  }, [loadWallet])

  // --- Первая загрузка и перечитывание после входа --------------------------

  useEffect(() => {
    // Пока профиль не подъехал из SWR, спрашивать нечего: ключ кэша ещё пустой,
    // и запрос ушёл бы впустую, а потом второй раз — с настоящим ключом.
    if (!currentProfile) return
    void loadDevices(false)
    void loadWallet(false)
  }, [currentProfile, loadDevices, loadWallet])

  // Вход завершился — перечитать всё немедленно.
  //
  // ⚠️ Без этого раздел оставался с «войдите в аккаунт» и после успешного
  // входа. Расчёт был на то, что подписка переимпортируется, у профиля
  // сменится updated, сменится ключ кэша и эффект выше сработает сам. Но у
  // того, кто уже подписан, импорт пропускается: адрес подписки тот же, и
  // второй профиль заводить нельзя (index.ts, проверка по url). Профиль не
  // менялся — значит и перечитывать было нечему.
  useEffect(() => {
    const onStatus = (_e: unknown, payload: ConnectStatusEvent): void => {
      if (payload.status !== 'done') return
      devicesCache = null
      walletCache = null
      void loadDevices(true)
      void loadWallet(true)
    }
    window.electron.ipcRenderer.on('subscription-connect-status', onStatus)
    return (): void => {
      window.electron.ipcRenderer.removeAllListeners('subscription-connect-status')
    }
  }, [loadDevices, loadWallet])

  // Есть ли вообще сессия кабинета — от этого зависит строка выхода. Отдельным
  // вопросом, а не выводом из ответа об устройствах: тот отвечает «error» и
  // когда панель молчит, а аккаунт при этом подключён.
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    let cancelled = false
    hasCabinetSession()
      .then((v) => {
        if (!cancelled) setSignedIn(v)
      })
      .catch(() => {
        // не смогли спросить — считаем, что выходить не из чего
      })
    return (): void => {
      cancelled = true
    }
  }, [devices])

  // Выход спрашивает подтверждение: он уносит подписку, а с ней и доступ.
  // Действие обратимое — войти можно снова, — но не бесплатное, и человек
  // должен понимать, что нажимает.
  const [confirmSignOut, setConfirmSignOut] = useState(false)

  const onSignOut = async (): Promise<void> => {
    setConfirmSignOut(false)
    // Кэши обязаны протухнуть сразу: иначе ещё минуту показывали бы устройства
    // и баланс аккаунта, из которого только что вышли.
    devicesCache = null
    walletCache = null
    setSignedIn(false)
    setWallet(null)
    await disconnectAccount()
    await loadDevices(true)
    await loadWallet(true)
  }

  const deviceList = devices?.state === 'ok' ? devices.devices : []
  const deviceTotal = devices?.state === 'ok' ? devices.total : 0

  // ⚠️ limit отсутствует при device_limit = 0, а это «лимит не задан», а не
  // «ноль устройств»: ни делить на него, ни продавать в него нельзя. Отдельной
  // переменной, а не флагом рядом с числом: так типы сами не пустят
  // undefined в деление, и приводить тип вручную не придётся.
  const deviceLimit =
    devices?.state === 'ok' && devices.limit !== undefined && devices.limit > 0
      ? devices.limit
      : undefined
  const limitKnown = deviceLimit !== undefined
  const deviceFree = deviceLimit === undefined ? undefined : deviceLimit - deviceTotal
  const deviceShare =
    deviceLimit === undefined ? 0 : Math.min(100, Math.round((deviceTotal / deviceLimit) * 100))
  // Для маленьких целых проценты бессмысленны: «86 % занято» из 21 места — это
  // «осталось три», и человеку нужно второе. Поэтому цвет — по числу свободных
  // мест, а не по доле.
  const deviceBarColor =
    deviceFree === undefined || deviceFree > 1
      ? 'bg-[color:var(--sn-accent)]'
      : deviceFree === 1
        ? 'bg-warning'
        : 'bg-destructive'

  // Один отказ на весь кабинет: если сессию не приняли для устройств, то не приняли ни для
  // баланса, ни для цены. Три одинаковых «войдите» на экране 460 px — это шум,
  // поэтому в этом случае показываем ОДНУ группу.
  //
  // ⚠️ Решаем только по ответу об устройствах, а НЕ по балансу: иначе один отказ
  // кошелька спрятал бы уже полученный список устройств. Свой «войдите» кошелёк
  // покажет сам, строкой в своей группе.
  const cabinetUnauthorized = devices?.state === 'unauthorized'

  // --- Докупка устройств ----------------------------------------------------

  const [addCount, setAddCount] = useState(1)
  const [priceView, setPriceView] = useState<PriceView>({ kind: 'idle' })
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  // Сколько ещё можно добавить по словам СЕРВЕРА (can_add). undefined — сервер
  // не назвал, то есть максимума у тарифа нет.
  const [canAddCap, setCanAddCap] = useState<number | undefined>(undefined)
  // Прошлая покупка осталась без ответа. Плашка липкая: она снимается только
  // новым удачным расчётом, то есть после того, как человек увидел настоящий
  // баланс и лимит. Начальное значение берём с модуля — экран мог
  // размонтироваться сразу после неудачной покупки.
  const [unknownOutcome, setUnknownOutcome] = useState(purchaseOutcomeUnknown)
  const markUnknownOutcome = useCallback((value: boolean): void => {
    purchaseOutcomeUnknown = value
    setUnknownOutcome(value)
  }, [])

  // Цену спрашивали хотя бы раз — значит изменение счётчика обязано её
  // пересчитывать. До первого «Узнать цену» счётчик молча ничего не запрашивает.
  const askedRef = useRef(false)
  // Номер запроса цены: ответ со старым номером выбрасываем.
  const priceSeqRef = useRef(0)
  // Номер потока подтверждения: тем же приёмом выбрасываем пересчёт цены,
  // который пришёл в уже закрытый диалог.
  const confirmSeqRef = useRef(0)
  // Диалог подтверждения открыт. Ref, а не state: два щелчка по «Докупить» в
  // одном тике оба увидели бы confirm === null и завели бы два потока.
  const confirmOpenRef = useRef(false)
  // ⚠️ ЗАМОК ДЕНЕГ. Ref, потому что setState асинхронный: второе нажатие в том
  // же тике проскочило бы мимо disabled, посчитанного по state. Замок ставится
  // ДО ухода запроса.
  const purchaseLockRef = useRef(false)

  // Все расчёты цены идут по ОДНОЙ цепочке, никогда параллельно. Причина не в
  // нагрузке: в главном процессе живёт ровно один последний расчёт (lastQuote,
  // connect.ts:1042), и два запроса в полёте означают, что в силе останется
  // тот, чей ответ пришёл позже, — то есть, возможно, не тот, что на экране.
  // Покупка по «чужому» расчёту получила бы staleQuote, и человек увидел бы
  // «цена могла измениться» ни за что.
  const quoteChainRef = useRef<Promise<void>>(Promise.resolve())
  const runQuote = useCallback((count: number): Promise<CabinetDeviceQuoteResult> => {
    const run = quoteChainRef.current.then(() => fetchCabinetDeviceQuote(count))
    // Обработчики на оба исхода обязательны: без них отказ в цепочке стал бы
    // необработанным отклонением и уронил бы все следующие расчёты.
    quoteChainRef.current = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }, [])

  // Разбор ответа расчёта в состояние блока цены. Возвращает разобранный вид,
  // чтобы им же воспользовался поток подтверждения.
  const applyQuote = useCallback(
    (result: CabinetDeviceQuoteResult | undefined, count: number): PriceResolved => {
      if (!result) return { kind: 'broken' }
      if (result.state === 'unavailable') {
        setCanAddCap(result.canAdd)
        // reason приходит от сервера уже по-русски («Достигнут максимум
        // устройств (5)»), поэтому показываем его как есть.
        return { kind: 'unavailable', reason: result.reason }
      }
      if (result.state !== 'ok') return { kind: 'failed', failure: result }
      // ⚠️ Расчёт не на то количество к показу не годится: рядом со счётчиком
      // «2» нельзя показывать цену одного устройства.
      if (!quoteIsSane(result.quote, count)) return { kind: 'broken' }
      setCanAddCap(result.quote.canAdd)
      // Удачный расчёт снимает липкую плашку: человек только что увидел
      // настоящие баланс и лимит — ровно то условие, которого требует главный
      // процесс, прежде чем снова пустить покупку (connect.ts:1185).
      markUnknownOutcome(false)
      return { kind: 'ok', quote: result.quote }
    },
    [markUnknownOutcome]
  )

  const loadPrice = useCallback(
    async (count: number): Promise<void> => {
      const seq = ++priceSeqRef.current
      setPriceView({ kind: 'loading' })
      let result: CabinetDeviceQuoteResult | undefined
      try {
        result = await runQuote(count)
      } catch {
        result = undefined
      }
      if (priceSeqRef.current !== seq || !aliveRef.current) return
      setPriceView(applyQuote(result, count))
    },
    [applyQuote, runQuote]
  )

  // Цена НЕ подгружается сама при появлении экрана, и это осознанно.
  //
  // ⚠️ Каждый расчёт снимает в главном процессе защёлку «исход прошлой покупки
  // неизвестен» (connect.ts:1166). Защёлка на то и стоит, чтобы человек не
  // нажал «купить» второй раз, не посмотрев на баланс. Автозапрос цены при
  // каждом заходе на вкладку снимал бы её за человека, у него за спиной.
  // Поэтому цена появляется только после явного действия — и вторая причина
  // та же: цена живёт 90 с (QUOTE_TTL), и показывать большую сумму рядом с живой
  // кнопкой списания тому, кто просто зашёл посмотреть срок подписки,
  // незачем.
  //
  // Если решится иначе и цену захотится показывать сразу, автозапрос добавляется
  // ровно здесь — одним эффектом, но ОБЯЗАТЕЛЬНО под условием
  // `!purchaseOutcomeUnknown`: иначе заход на вкладку будет снимать защёлку после
  // потерянного ответа на покупку.
  const askPrice = useCallback((): void => {
    askedRef.current = true
    void loadPrice(addCount)
  }, [addCount, loadPrice])

  // Изменение счётчика обязано пересчитывать цену. Сначала гасим показанную
  // (внутри loadPrice), потом пауза — состояния «цена от прошлого числа рядом с
  // новым» не существует ни на кадр.
  useEffect(() => {
    if (!askedRef.current) return undefined
    setPriceView({ kind: 'loading' })
    const timer = setTimeout(() => {
      void loadPrice(addCount)
    }, PRICE_DEBOUNCE_MS)
    return (): void => {
      clearTimeout(timer)
    }
  }, [addCount, loadPrice])

  // Сервер назвал предел — прижимаем счётчик к нему. Иначе человек выберет 5,
  // увидит «можно добавить максимум 2» и останется с бесполезным числом.
  useEffect(() => {
    if (canAddCap === undefined) return
    const cap = Math.max(1, Math.min(canAddCap, MAX_DEVICES_PER_STEP))
    setAddCount((prev) => (prev > cap ? cap : prev))
  }, [canAddCap])

  const stepMax =
    canAddCap === undefined
      ? MAX_DEVICES_PER_STEP
      : Math.max(1, Math.min(canAddCap, MAX_DEVICES_PER_STEP))

  // Докупка исчезает целиком, когда лимит неизвестен.
  //
  // ⚠️ ДЕНЬГИ. При device_limit = 0 ручка цены считает текущий лимит за 1
  // (`device_limit or 1`, devices.py:801), а покупка ставит лимит равным
  // 1 + купленное. То есть покупка в «лимит не задан» может ПРЕВРАТИТЬ
  // незаданный лимит в жёсткую двойку — человек заплатит за то, чтобы у него
  // стало меньше. Пока смысл нуля на сервере не определён, здесь не продаём.
  const purchaseVisible = devices?.state === 'ok' && limitKnown

  const closeConfirm = useCallback((): void => {
    // Подстраховка: диалог и так не даёт себя закрыть, пока запрос в полёте.
    if (purchaseLockRef.current) return
    confirmOpenRef.current = false
    // Обесцениваем номер потока: пересчёт цены, который вернётся после
    // закрытия, не имеет права открыть диалог заново.
    confirmSeqRef.current += 1
    setConfirm(null)
  }, [])

  /**
   * Открыть подтверждение. ⚠️ ВСЕГДА пересчитывает цену: показанная в блоке
   * могла постоять минуту, а остаток подписки уменьшается каждые сутки, и
   * вчерашняя цифра — враньё. Цена из блока используется ТОЛЬКО для того, чтобы
   * сказать «цена изменилась», если она изменилась.
   */
  const openConfirm = useCallback((): void => {
    if (confirmOpenRef.current || purchaseLockRef.current) return
    confirmOpenRef.current = true
    const count = addCount
    const previousKopeks = priceView.kind === 'ok' ? priceView.quote.priceKopeks : undefined
    setConfirm({ stage: 'quoting' })
    const seq = ++confirmSeqRef.current
    void (async () => {
      let result: CabinetDeviceQuoteResult | undefined
      try {
        result = await runQuote(count)
      } catch {
        result = undefined
      }
      if (confirmSeqRef.current !== seq || !aliveRef.current) return
      const view = applyQuote(result, count)
      // Блок цены обновляем тоже: этот расчёт свежее того, что там лежал.
      setPriceView(view)
      if (view.kind === 'ok') {
        setConfirm({ stage: 'ready', quote: view.quote, previousKopeks })
        return
      }
      setConfirm({ stage: 'quoteFailed', failure: view })
    })()
  }, [addCount, applyQuote, priceView, runQuote])

  /**
   * Списать. Единственное место в приложении, которое тратит деньги.
   *
   * ⚠️ Замок ставится ДО ухода запроса и НЕ снимается по таймеру: второе
   * нажатие не отправляет ничего — ни повторно, ни «на всякий случай».
   * Серверные локи от двух одинаковых нажатий не защищают: каждое спишет.
   */
  const doPurchase = useCallback(
    (quote: CabinetDeviceQuote): void => {
      if (purchaseLockRef.current) return
      purchaseLockRef.current = true
      // Кнопка гаснет ЗДЕСЬ — до первого await, то есть до того, как запрос
      // физически может уйти.
      setConfirm({ stage: 'sending', quote })
      void (async () => {
        let result: CabinetDevicePurchaseResult
        try {
          result = await purchaseCabinetDevices(quote.id)
        } catch {
          // Канал ipc оборвался посреди вызова. Это НЕ «не отправилось»:
          // главный процесс мог успеть отправить запрос. Исход неизвестен —
          // и трактуем его как самый опасный из возможных.
          result = { state: 'unknown', message: '' }
        }
        purchaseLockRef.current = false

        // Расчёт в главном процессе одноразовый: после отправки он стёрт
        // (connect.ts:1225), значит цена на экране мертва при любом исходе.
        askedRef.current = false
        // Кэши протухают ВСЕГДА, даже если экран уже размонтировали: и лимит, и
        // баланс могли измениться, а возврат на вкладку не должен показать
        // цифры «до покупки».
        devicesCache = null
        walletCache = null
        // ⚠️ Флаг «исход неизвестен» ставим ДО проверки на размонтирование, и
        // прямо на модуле: экран мог закрыться, пока запрос был в полёте, а
        // предупреждение о возможном списании обязано дожить до возвращения.
        if (result.state === 'unknown') purchaseOutcomeUnknown = true

        if (!aliveRef.current) return
        setPriceView({ kind: 'idle' })
        if (result.state === 'unknown') markUnknownOutcome(true)
        setConfirm({ stage: 'done', result })
        void loadDevices(true)
        void loadWallet(true)
      })()
    },
    [loadDevices, loadWallet, markUnknownOutcome]
  )

  // --- Лист одного устройства -----------------------------------------------

  // СНИМОК устройства, а не его hwid. Пока лист открыт, он обязан рисоваться
  // даже если устройство ушло из свежего ответа кабинета: иначе лист опустеет
  // посреди операции, и человек не узнает, сработало ли.
  const [selected, setSelected] = useState<CabinetDevice | null>(null)

  // Устройство пропало из последнего ответа кабинета.
  //
  // ⚠️ Считаем только когда ответ ВООБЩЕ ЕСТЬ: при ошибке запроса список пуст
  // не потому, что устройство ушло, а потому что спросить не удалось, и поднятый
  // флаг сказал бы человеку неправду про его железку.
  //
  // ⚠️ Устройство без hwid отличить от другого безымянного нечем, а лист с ним
  // всё равно ничего не делает (объясняет баннером). Утверждать «его нет в списке»
  // было бы догадкой, поэтому для таких — false.
  const selectedMissing =
    devices?.state === 'ok' &&
    !!selected &&
    selected.hwid !== '' &&
    !deviceList.some((d) => d.hwid === selected.hwid)

  if (!hasProfiles) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <TitleStrip title={t('pages.subscription.title')} />
        <div className="flex flex-1 items-center justify-center px-5 pb-(--nav-space)">
          <SubscriptionEmptyState onManual={() => navigate('/profiles')} />
        </div>
      </div>
    )
  }

  const labelClass =
    'shrink-0 text-[10px] font-semibold uppercase leading-[13px] tracking-[0.09em] text-muted-foreground'

  // Текст отказа кабинета.
  //
  // ⚠️ Ключи error.* живут в i18n ГЛАВНОГО процесса (src/main/utils/i18n.ts) и в
  // рендерере их НЕ существует. Поэтому message, который main уже перевёл,
  // показываем как есть, а для состояний без message («войдите», «нет
  // подписки») берём свои ключи: у них message отсутствует намеренно — это не
  // сообщения, а развилки.
  const failureLine = (
    failure: CabinetFailure,
    fallback: string
  ): { text: string; signIn: boolean } => {
    if (failure.state === 'unauthorized') {
      return { text: t('pages.subscription.purchase.failUnauthorized'), signIn: true }
    }
    if (failure.state === 'noSubscription') {
      return { text: t('pages.subscription.purchase.failNoSubscription'), signIn: false }
    }
    return { text: failure.message || fallback, signIn: false }
  }

  const priceFailureText = (failure: PriceFailure): string => {
    if (failure.kind === 'unavailable') return failure.reason
    if (failure.kind === 'broken') return t('pages.subscription.purchase.priceBroken')
    return failureLine(failure.failure, t('pages.subscription.purchase.priceBroken')).text
  }

  // Отказ по балансу вытаскиваем ЗДЕСЬ, а не в разметке: в тернарной цепочке типы не
  // сужаются сквозь wallet?.balance.state, и там пришлось бы приводить тип
  // руками — а приведение типа в месте, где решается, что показать про деньги,
  // — плохое место для приведения типа.
  const balanceOk = wallet && wallet.balance.state === 'ok' ? wallet.balance : null
  const balanceFailure: CabinetFailure | null =
    wallet && wallet.balance.state !== 'ok' ? wallet.balance : null
  // Считаем один раз: текст и решение «войти или повторить» обязаны
  // приходить из одного разбора, а не из двух вызовов в разметке.
  const balanceLine = balanceFailure
    ? failureLine(balanceFailure, t('pages.subscription.wallet.error'))
    : null

  // Последняя операция кошелька: подпись, сумма, когда.
  const lastTx =
    wallet?.lastTx.state === 'ok' && wallet.lastTx.items.length > 0 ? wallet.lastTx.items[0] : null
  // ⚠️ skipped > 0 значит, что запись прочитать не удалось — в истории денег
  // дыра. Молча показать «операций нет» тут нельзя: это разные вещи.
  const lastTxSkipped = wallet?.lastTx.state === 'ok' ? wallet.lastTx.skipped > 0 : false
  const lastTxLabel = lastTx
    ? lastTx.description?.trim() ||
      (TX_LABEL_KEYS[lastTx.type]
        ? t(TX_LABEL_KEYS[lastTx.type])
        : t('pages.subscription.wallet.opOther'))
    : ''

  // Тело диалога подтверждения. Вынесено функцией, чтобы разметка экрана не
  // утонула в развилках по исходу покупки.
  const renderConfirmBody = (state: ConfirmState): React.ReactNode => {
    if (state.stage === 'quoting') {
      // Текст стоит в описании диалога (confirmLead), здесь только живой
      // признак того, что запрос идёт. Одна и та же фраза дважды в одном
      // окне читается как ошибка разметки.
      return (
        <div className="flex h-8 items-center">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      )
    }

    if (state.stage === 'quoteFailed') {
      const failure = state.failure
      const signIn = failure.kind === 'failed' && failure.failure.state === 'unauthorized'
      return (
        <>
          <p className="text-sm text-foreground">{priceFailureText(failure)}</p>
          {signIn && (
            <Button
              variant="secondary"
              className="mt-3 w-full"
              onClick={() => {
                closeConfirm()
                openLogin(true)
              }}
            >
              {t('subscription.signIn')}
            </Button>
          )}
        </>
      )
    }

    if (state.stage === 'ready' || state.stage === 'sending') {
      const quote = state.quote
      // Имя с префиксом: ниже в компоненте есть свой sending на весь диалог,
      // и два одинаковых имени в одном файле про одно и то же состояние
      // рано или поздно разошлись бы.
      const isSending = state.stage === 'sending'
      // Сначала достаём значение, потом сравниваем: читать
      // state.previousKopeks ниже, в разметке, нельзя — у фазы 'sending'
      // такого поля нет, и булев флаг типы за нас не сузит.
      const previousKopeks = state.stage === 'ready' ? state.previousKopeks : undefined
      const changed = previousKopeks !== undefined && previousKopeks !== quote.priceKopeks
      return (
        <>
          {/* Три из четырёх обязательных вещей подтверждения — сумма, новый
              лимит, остаток после списания — плюс четвёртая строка,
              объясняющая сумму: за сколько дней заплачено. Четвёртое
              обязательное — «возврата не будет» — стоит ниже, отдельной
              красной строкой: в столбик с цифрами оно бы утонуло. */}
          <div className="rounded-xl border border-stroke bg-background/40 px-3 py-1.5">
            <MoneyRow
              label={t('pages.subscription.purchase.rowPrice')}
              value={formatKopeks(quote.priceKopeks)}
              strong
            />
            <MoneyRow
              label={t('pages.subscription.purchase.rowLimit')}
              value={`${quote.currentLimit} → ${quote.newLimit}`}
            />
            <MoneyRow
              label={t('pages.subscription.purchase.rowBalanceAfter')}
              value={formatKopeks(quote.balanceAfterKopeks)}
            />
            {/* Срок берём готовым ключом остатка дней (тем же, что у меры
                выше): число дней на одном экране обязано склоняться одинаково. */}
            <MoneyRow
              label={t('pages.subscription.purchase.rowDays')}
              value={t('pages.more.subscription.daysLeft', { count: quote.daysLeft })}
            />
          </div>

          {changed && (
            <p className="mt-2 text-xs text-warning">
              {t('pages.subscription.purchase.priceChanged', {
                was: formatKopeks(previousKopeks)
              })}
            </p>
          )}

          {/* ⚠️ Денег не хватает — и это могло выясниться ИМЕННО ЗДЕСЬ: в блоке
              цены баланса хватало, а пересчёт перед подтверждением увидел
              списание, прошедшее где-то ещё. Покупку не отправляем вовсе:
              кнопки списания в этом случае нет ни в теле, ни в подвале, а
              предупреждение о невозвратности здесь только пугало бы: списывать
              нечего. */}
          {quote.enough ? (
            /* ⚠️ В данных этого нет и быть не может: «возврата не будет» —
               это факт про сервер (маршрута возврата в пользовательском API не
               существует вовсе), а не поле ответа. */
            <p className="mt-2.5 flex gap-1.5 text-xs text-destructive">
              <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{t('pages.subscription.purchase.noRefund')}</span>
            </p>
          ) : (
            <>
              <p className="mt-2.5 text-xs text-warning">
                {t('pages.subscription.purchase.notEnough', {
                  amount: formatKopeks(quote.priceKopeks - quote.balanceKopeks)
                })}
              </p>
              <Button variant="secondary" className="mt-2 w-full" onClick={openTopUp}>
                <Wallet aria-hidden />
                {t('pages.subscription.purchase.topUp')}
              </Button>
            </>
          )}

          {isSending && (
            <p className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              <span>{t('pages.subscription.purchase.dontClose')}</span>
            </p>
          )}
        </>
      )
    }

    // stage === 'done'
    const result = state.result

    if (result.state === 'ok') {
      return (
        <>
          <p className="text-sm text-foreground">
            {t('pages.subscription.purchase.doneText', {
              amount: formatKopeks(result.chargedKopeks),
              limit: result.newLimit,
              balance: formatKopeks(result.balanceKopeks)
            })}
          </p>
          {/* Сервер пересчитывает цену сам и мог списать не то, что называл
              расчёт. Расхождение показываем, а не прячем. */}
          {result.chargedKopeks !== result.quotedKopeks && (
            <p className="mt-2 text-xs text-warning">
              {t('pages.subscription.purchase.doneDiff', {
                quoted: formatKopeks(result.quotedKopeks),
                charged: formatKopeks(result.chargedKopeks)
              })}
            </p>
          )}
        </>
      )
    }

    if (result.state === 'insufficient') {
      const known = result.requiredKopeks !== undefined && result.balanceKopeks !== undefined
      return (
        <>
          <p className="text-sm text-foreground">
            {known
              ? t('pages.subscription.purchase.insufficientText', {
                  required: formatKopeks(result.requiredKopeks),
                  balance: formatKopeks(result.balanceKopeks),
                  missing: formatKopeks(
                    result.missingKopeks ??
                      (result.requiredKopeks ?? 0) - (result.balanceKopeks ?? 0)
                  )
                })
              : t('pages.subscription.purchase.insufficientPlain')}
          </p>
          {/* ⚠️ Сервер СОХРАНИЛ корзину: следующее пополнение докупит
              устройства само, без нового подтверждения. Человек, который просто
              положит денег, иначе обнаружит списание, которого не ждал. */}
          {result.cartSaved && (
            <p className="mt-2 flex gap-1.5 text-xs text-warning">
              <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{t('pages.subscription.purchase.cartSaved')}</span>
            </p>
          )}
          <Button variant="secondary" className="mt-3 w-full" onClick={openTopUp}>
            <Wallet aria-hidden />
            {t('pages.subscription.purchase.topUp')}
          </Button>
        </>
      )
    }

    if (result.state === 'limitReached') {
      return (
        <>
          <p className="text-sm text-foreground">{result.message}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {result.refunded
              ? t('pages.subscription.purchase.limitRefunded')
              : t('pages.subscription.purchase.notCharged')}
          </p>
        </>
      )
    }

    if (result.state === 'unknown') {
      return (
        <>
          {/* Самое опасное состояние: деньги могли списаться, устройства могли
              не прибавиться. Никакого «повторить» здесь нет и быть не может. */}
          <p className="flex gap-1.5 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{result.message || t('pages.subscription.purchase.unknownText')}</span>
          </p>
          <Button
            variant="secondary"
            className="mt-3 w-full"
            onClick={() => window.open(cabinetUrl)}
          >
            <AppWindow aria-hidden />
            {t('pages.subscription.purchase.openCabinet')}
          </Button>
        </>
      )
    }

    if (result.state === 'busy' || result.state === 'staleQuote') {
      return (
        <>
          <p className="text-sm text-foreground">{result.message}</p>
          {/* Главный процесс здесь ничего не отправлял — это его гарантия, а не
              наша надежда (connect.ts:1177-1205). Значит про деньги можно
              сказать прямо. */}
          <p className="mt-2 text-xs text-muted-foreground">
            {t('pages.subscription.purchase.nothingSent')}
          </p>
          {result.state === 'staleQuote' && (
            <Button
              variant="secondary"
              className="mt-3 w-full"
              onClick={() => {
                // Пересчёт ЦЕНЫ, а не повтор покупки: откроется новое
                // подтверждение с новой суммой, и согласиться придётся заново.
                closeConfirm()
                openConfirm()
              }}
            >
              {t('pages.subscription.purchase.requote')}
            </Button>
          )}
        </>
      )
    }

    // Остальное — отказы ДО списания: 401/403/404/400/422/429 и обслуживание.
    // Что денег не тронули, здесь факт: все 400 в обработчике покупки подняты
    // раньше списания (connect.ts:1349-1352).
    const line = failureLine(result, t('pages.subscription.purchase.priceBroken'))
    return (
      <>
        <p className="text-sm text-foreground">{line.text}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('pages.subscription.purchase.notCharged')}
        </p>
        {line.signIn && (
          <Button
            variant="secondary"
            className="mt-3 w-full"
            onClick={() => {
              closeConfirm()
              openLogin(true)
            }}
          >
            {t('subscription.signIn')}
          </Button>
        )}
      </>
    )
  }

  const confirmTitle = (state: ConfirmState): string => {
    if (state.stage === 'done') {
      const result = state.result
      if (result.state === 'ok') return t('pages.subscription.purchase.doneTitle')
      if (result.state === 'insufficient')
        return t('pages.subscription.purchase.insufficientTitle')
      if (result.state === 'limitReached') return t('pages.subscription.purchase.limitTitle')
      if (result.state === 'unknown') return t('pages.subscription.purchase.unknownTitle')
      if (result.state === 'busy') return t('pages.subscription.purchase.busyTitle')
      if (result.state === 'staleQuote') return t('pages.subscription.purchase.staleTitle')
      return t('pages.subscription.purchase.failedTitle')
    }
    if (state.stage === 'quoteFailed') return t('pages.subscription.purchase.failedTitle')
    // Цена пересчитана и денег уже не хватает — вопрос «докупить?» здесь
    // бессмыслен: ответить на него «да» невозможно.
    if (state.stage === 'ready' && !state.quote.enough) {
      return t('pages.subscription.purchase.insufficientTitle')
    }
    // Заголовок не меняется между «уточняем», «подтвердите» и «списываем»:
    // диалог не должен прыгать под рукой, пока идёт запрос.
    const count = state.stage === 'quoting' ? addCount : state.quote.devices
    return t('pages.subscription.purchase.confirmTitle', { count })
  }

  const sending = confirm?.stage === 'sending'

  // Одна фраза под заголовком диалога. ⚠️ Radix рисует описание абзацем, и
  // вложить туда блочную разметку с числами нельзя — будет невалидный html.
  // Поэтому здесь только тема разговора, а суммы — своим блоком ниже.
  const confirmLead =
    confirm?.stage === 'sending' || (confirm?.stage === 'ready' && confirm.quote.enough)
      ? t('pages.subscription.purchase.confirmLead')
      : confirm?.stage === 'quoting'
        ? t('pages.subscription.purchase.confirmQuoting')
        : ''

  return (
    // --sn-accent обязателен здесь, на корне ЭКРАНА: карточка и полоса читают
    // его через var(), а общего токена под синий акцент в @theme нет (то же
    // решение и тем же литералом стоит в home.tsx:347 и server-list.tsx:160).
    <div className="flex h-full min-h-0 flex-col overflow-hidden [--sn-accent:#2563eb] dark:[--sn-accent:#3b82f6]">
      <TitleStrip title={t('pages.subscription.title')} />

      <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-(--nav-space)">
        {/* --- Мера ------------------------------------------------------
            Концепт «Мера»: подписи сверху, значения снизу, полоса между ними.
            Полоса физически связывает трафик и срок в один предмет вместо двух
            отдельных плиток, и каждый элемент отвечает ровно на один вопрос:
            как называется тариф, живой ли он (точка), свежие ли цифры (вторая
            строка), сколько трафика (слева), сколько времени и до какого числа
            (справа), как обновить (кнопка).

            ⚠️ У концепта шкала рисовалась ВСЕГДА, в том числе при безлимите —
            автор это признаёт изъяном. При безлимите делить не на что, а полная
            полоса читается как «трафик кончился», то есть ровно наоборот. Здесь
            при total <= 0 полосы нет совсем: слева встаёт знак бесконечности, и
            вся смысловая нагрузка честно перетекает вправо, во время. */}
        <section
          className={cn(
            'relative mb-4 rounded-xl border bg-card/50 p-3.5 backdrop-blur-xl',
            cardState === 'expired'
              ? 'border-destructive/40 [--sn-card:var(--destructive)] [--sn-live:var(--destructive)]'
              : cardState === 'warn'
                ? 'border-warning/40 [--sn-card:var(--warning)] [--sn-live:var(--warning)]'
                : 'border-stroke [--sn-card:var(--sn-accent)] [--sn-live:var(--success)]'
          )}
          style={{
            // Подсвет сверху слева из концепта. Держим на --sn-card, чтобы
            // тревожное и истёкшее состояния не пришлось красить отдельными
            // правилами.
            // ⚠️ На светлой «шампани» синий подсвет почти не виден (о синем по
            // шампани предупреждает main.css:59). Это допустимо: подсвет —
            // украшение, ни одного смысла на нём не висит.
            backgroundImage:
              'radial-gradient(130% 90% at 6% -10%, color-mix(in oklab, var(--sn-card) 13%, transparent), transparent 60%)'
          }}
        >
          {/* Шапка: знак, имя, состояние, действия. Высота зафиксирована на 34 —
              как у знака, — иначе появление чипа или второй строки дёргало бы
              меру под ней. */}
          <div className="flex h-[34px] items-center gap-2.5">
            <div className="relative size-[34px] shrink-0">
              <div
                aria-hidden
                className="flex size-[34px] items-center justify-center rounded-full bg-[color:var(--sn-card)] text-base font-bold leading-none text-white"
                style={{
                  boxShadow:
                    'inset 0 1px 0 rgb(255 255 255 / 26%), 0 2px 12px color-mix(in oklab, var(--sn-card) 30%, transparent)'
                }}
              >
                {initial}
                {currentProfile?.logo && (
                  <img
                    src={currentProfile.logo}
                    alt=""
                    className="absolute inset-0 size-full rounded-full object-cover"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                )}
              </div>

              {/* Точка состояния сидит на знаке, как «в сети» у аватара:
                  состояние принадлежит подписке, а не отдельной строке, и не
                  отбирает ширины у названия. Рамка цветом карточки нужна, чтобы
                  точка не слипалась со знаком. */}
              <span
                role={stateChip ? 'img' : undefined}
                aria-label={stateChip || undefined}
                aria-hidden={stateChip ? undefined : true}
                className="absolute -right-px -bottom-px size-[11px] rounded-full border-2 border-card bg-[color:var(--sn-live)]"
                style={{
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--sn-live) 30%, transparent)'
                }}
              />
            </div>

            {/* Единственная тянущаяся зона шапки. min-w-0 обязателен: без него
                длинное имя тарифа не обрежется, а растянет шапку и выдавит
                кнопки за край карточки. 20 + 13 = 33 внутри 34. */}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <h2
                  title={currentProfile?.name}
                  className="truncate text-base font-semibold tracking-[-0.01em] text-foreground"
                >
                  {name || t('pages.more.subscription.none')}
                </h2>
                {stateChip && (
                  <span className="flex h-[17px] shrink-0 items-center rounded-full border border-[color:color-mix(in_oklab,var(--sn-live)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--sn-live)_14%,transparent)] px-1.5 text-xs font-semibold leading-none text-[color:var(--sn-live)]">
                    {stateChip}
                  </span>
                )}
              </div>
              {/* Вторая строка отвечает на единственный вопрос, который остаётся
                  после цифр ниже: свежие ли они. */}
              <p className="truncate text-xs text-muted-foreground">
                {currentProfile?.updated
                  ? t('pages.subscription.updatedAgo', {
                      ago: dayjs(currentProfile.updated).fromNow()
                    })
                  : t('pages.subscription.updatedNever')}
              </p>
            </div>

            {/* «Продлить» появляется ТОЛЬКО в тревоге и истечении. В обычном
                состоянии пилюли нет намеренно: «Личный кабинет» и «Поддержка»
                стоят группой ниже, на том же экране, и дублировать их в шапке
                значит показать одно действие дважды. А продлить из списка ниже
                нельзя — поэтому это единственное, что заслуживает шапки. */}
            {cardState !== 'ok' && renewAction && (
              <button
                type="button"
                onClick={() => window.open(renewAction.url)}
                title={renewAction.url}
                className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-[color:color-mix(in_oklab,var(--sn-card)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--sn-card)_10%,transparent)] px-[9px] text-xs font-semibold leading-none text-[color:var(--sn-card)] outline-none transition-colors hover:bg-[color:color-mix(in_oklab,var(--sn-card)_18%,transparent)] focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
              >
                <CreditCard className="size-3 shrink-0" aria-hidden />
                <span className="max-w-24 truncate">{renewAction.label}</span>
              </button>
            )}

            {/* Обновление стоит рядом со строкой «Обновлено N назад»: кнопка
                отвечает ровно на её вопрос. Одним нажатием обновляется и
                подписка, и список устройств — `updated` профиля меняется, ключ
                кэша устройств вместе с ним, и эффект перезапрашивает сам. */}
            {canUpdate && (
              <button
                type="button"
                onClick={onUpdate}
                disabled={updating}
                aria-busy={updating}
                aria-label={t('pages.more.subscription.update')}
                title={t('pages.more.subscription.update')}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)] disabled:opacity-40"
              >
                <RefreshCcw className={cn('size-3.5', updating && 'animate-spin')} />
              </button>
            )}
          </div>

          {hasMeter && (
            <div className="mt-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className={labelClass}>{t('pages.subscription.meterTraffic')}</span>
                <span className={labelClass}>{t('pages.subscription.daysLeftLabel')}</span>
              </div>

              {/* Полоса только при лимите — см. комментарий к usedShare.
                  Ободок дорожки задан внутренней тенью, а не border: border
                  забрал бы 2px из 8 высоты, и заполнение перестало бы доходить
                  до краёв дорожки.
                  Ширина заполнения не меньше 2%: при почти нулевом расходе
                  полоса иначе невидима, и непонятно, живая ли шкала вообще. */}
              {!unlimited && (
                <div
                  role="img"
                  aria-label={t('pages.subscription.trafficOf', {
                    used: calcTraffic(used),
                    total: calcTraffic(total)
                  })}
                  className="my-1.5 h-2 overflow-hidden rounded-full bg-background"
                  style={{ boxShadow: 'inset 0 0 0 1px var(--stroke)' }}
                >
                  <div
                    className={cn('h-full rounded-full transition-all', shareColor)}
                    style={{ width: `${Math.max(2, usedShare)}%` }}
                  />
                </div>
              )}

              <div className={cn('flex items-center justify-between gap-3', unlimited && 'mt-1.5')}>
                {/* Слева — трафик. */}
                {unlimited ? (
                  <span className="flex min-w-0 items-center gap-1">
                    {/* Знак бесконечности держим на синем акценте, а НЕ на
                        --sn-card: при истечении карточка краснеет, но трафик-то
                        по-прежнему безлимитный, и красное ∞ соврало бы про
                        него. Акцент тянет взгляд к хорошей новости. */}
                    <InfinityIcon
                      className="size-4 shrink-0 text-[color:var(--sn-accent)]"
                      strokeWidth={2.6}
                      aria-hidden
                    />
                    <span className="truncate text-sm font-semibold text-foreground">
                      {t('pages.subscription.unlimited')}
                    </span>
                  </span>
                ) : (
                  <span className="flex min-w-0 items-baseline">
                    <span className="truncate text-sm font-semibold tabular-nums text-foreground">
                      {calcTraffic(used)}
                    </span>
                    {/* Громко набрано израсходованное, тихо — знаменатель: в
                        вопросе «сколько ушло» меняется только первое число. */}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {` / ${calcTraffic(total)}`}
                    </span>
                  </span>
                )}

                {/* Справа — время. Разделитель тот же приём, что уже стоит на
                    главной у пары «вверх / вниз» (home.tsx:494). */}
                <span className="flex shrink-0 items-center gap-[7px]">
                  {isExpired ? (
                    <span className="text-sm font-semibold text-destructive">
                      {t('pages.more.subscription.expired')}
                    </span>
                  ) : expireAt > 0 ? (
                    <>
                      <span
                        className={cn(
                          'text-sm font-semibold tabular-nums',
                          cardState === 'ok' ? 'text-foreground' : 'text-[color:var(--sn-card)]'
                        )}
                      >
                        {/* Полное склонение, а не короткое «д»: на странице
                            подписки места хватает, а «224 дня» с готовыми
                            формами _one/_few/_many честнее, чем «224 д». */}
                        {t('pages.more.subscription.daysLeft', { count: daysRemaining })}
                      </span>
                      <span aria-hidden className="h-2.5 w-px bg-stroke" />
                      <span className="text-xs text-muted-foreground">
                        {t('pages.subscription.until', {
                          date: dayjs.unix(expireAt).format('L')
                        })}
                      </span>
                    </>
                  ) : (
                    // ⚠️ Бессрочная подписка (expire = 0) обязана показывать ∞:
                    // «0 дней» на ней было бы прямой ложью.
                    <InfinityIcon
                      role="img"
                      className="size-4 text-foreground"
                      strokeWidth={2.6}
                      aria-label={t('pages.home.never')}
                    />
                  )}
                </span>
              </div>
            </div>
          )}
        </section>

        {cabinetUnauthorized ? (
          // Сессию не приняли — кабинетных данных нет вообще никаких. Одна
          // группа с одним предложением вместо трёх одинаковых «войдите» в
          // кошельке, лимите и списке устройств.
          <Group title={t('pages.subscription.account.title')}>
            <p className="px-3 py-2.5 text-xs text-muted-foreground">
              {t('pages.subscription.account.hint')}
            </p>
            {/* Тот же путь входа, что у карточки «подписка не подключена»:
                диалог входа живёт один на всё приложение и открывается флагом
                из login-store, а не своим потоком на каждом экране. */}
            <Row
              icon={LogIn}
              label={t('subscription.signIn')}
              trailing="chevron"
              onClick={() => openLogin(true)}
            />
          </Group>
        ) : (
          <>
            {/* --- Кошелёк ---------------------------------------------------
                Баланс крупно, потому что это единственное число, от которого
                зависит, можно ли вообще что-то докупить. Пополнение — в
                браузер: оплату в приложении мы не принимаем. */}
            <Group title={t('pages.subscription.wallet.title')}>
              {/* По отсутствию снимка, а НЕ по walletLoading: флаг загрузки
                  встаёт уже в эффекте, а первый кадр рисуется до него — и
                  кошелёк на мгновение оказывался пустой рамкой. А если профиль
                  так и не подъедет, запрос не начнётся вовсе, и рамка останется
                  пустой навсегда. */}
              {!wallet ? (
                <div className="flex h-10 items-center gap-2.5 px-3">
                  <Spinner className="size-3.5 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {t('pages.subscription.wallet.loading')}
                  </span>
                </div>
              ) : balanceOk ? (
                <div className="px-3 py-3">
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <p className={labelClass}>{t('pages.subscription.wallet.balance')}</p>
                      <p className="mt-0.5 truncate text-2xl font-semibold tabular-nums leading-tight text-foreground">
                        {formatKopeks(balanceOk.balanceKopeks)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={refreshWallet}
                        disabled={walletLoading}
                        aria-busy={walletLoading}
                        aria-label={t('pages.subscription.wallet.refresh')}
                        title={t('pages.subscription.wallet.refresh')}
                        className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)] disabled:opacity-40"
                      >
                        <RefreshCcw className={cn('size-3.5', walletLoading && 'animate-spin')} />
                      </button>
                      <Button size="sm" onClick={openTopUp}>
                        <Wallet aria-hidden />
                        {t('pages.subscription.wallet.topUp')}
                      </Button>
                    </div>
                  </div>

                  {/* Последняя операция мелким: она не действие, а объяснение
                      того, почему баланс такой. */}
                  <p className="mt-1.5 truncate text-xs text-muted-foreground">
                    {lastTxSkipped ? (
                      t('pages.subscription.wallet.lastOpBroken')
                    ) : lastTx ? (
                      <>
                        {`${t('pages.subscription.wallet.lastOp')} `}
                        <span className="text-foreground">{lastTxLabel}</span>
                        {' · '}
                        <span
                          className={cn(
                            'tabular-nums',
                            lastTx.amountKopeks > 0 ? 'text-success' : 'text-foreground'
                          )}
                        >
                          {formatSignedKopeks(lastTx.amountKopeks)}
                        </span>
                        {/* ⚠️ Время из будущего прижимаем к «сейчас»: часы
                            сервера и Мака расходятся на минуты, а «пополнение через
                            2 минуты» в истории читается как поломка. */}
                        {lastTx.createdAt
                          ? ` · ${dayjs(Math.min(lastTx.createdAt, Date.now())).fromNow()}`
                          : ''}
                        {/* ⚠️ Незавершённый платёж нельзя показывать как
                            прошедший: денег на балансе ещё нет. */}
                        {!lastTx.completed
                          ? ` · ${t('pages.subscription.wallet.lastOpPending')}`
                          : ''}
                      </>
                    ) : (
                      t('pages.subscription.wallet.lastOpNone')
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('pages.subscription.wallet.topUpHint')}
                  </p>
                </div>
              ) : balanceLine ? (
                <>
                  <p className="px-3 py-2.5 text-xs text-destructive">{balanceLine.text}</p>
                  {/* Кнопка по смыслу отказа, а не одна на все: если сессию не
                      приняли, «повторить» не поможет никогда. */}
                  {balanceLine.signIn ? (
                    <Row
                      icon={LogIn}
                      label={t('subscription.signIn')}
                      trailing="chevron"
                      onClick={() => openLogin(true)}
                    />
                  ) : (
                    <Row
                      icon={RefreshCcw}
                      label={t('pages.home.connectRetry')}
                      busy={walletLoading}
                      disabled={walletLoading}
                      onClick={refreshWallet}
                    />
                  )}
                </>
              ) : null}
            </Group>

            {/* --- Лимит устройств ------------------------------------------
                Занятость и докупка стоят ОДНОЙ группой: «сколько мест» и
                «добавить мест» — один и тот же предмет, и разносить их по двум
                карточкам значило бы заставлять глаз сверять числа. */}
            {devices?.state === 'ok' && (
              <Group title={t('pages.subscription.limit.title')}>
                <div className="px-3 py-3">
                  {limitKnown ? (
                    <>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold tabular-nums text-foreground">
                          {t('pages.subscription.limit.count', {
                            used: deviceTotal,
                            limit: deviceLimit
                          })}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {deviceFree === undefined
                            ? ''
                            : deviceFree < 0
                              ? t('pages.subscription.limit.over')
                              : deviceFree === 0
                                ? t('pages.subscription.limit.full')
                                : t('pages.subscription.limit.free', { count: deviceFree })}
                        </span>
                      </div>
                      {/* Дорожка и ободок — те же, что у полосы трафика в мере:
                          две шкалы на одном экране обязаны быть одним
                          предметом, а не двумя разными. */}
                      <div
                        role="img"
                        aria-label={t('pages.subscription.limit.bar', {
                          used: deviceTotal,
                          limit: deviceLimit
                        })}
                        className="mt-1.5 h-2 overflow-hidden rounded-full bg-background"
                        style={{ boxShadow: 'inset 0 0 0 1px var(--stroke)' }}
                      >
                        <div
                          className={cn('h-full rounded-full transition-all', deviceBarColor)}
                          style={{ width: `${Math.max(2, deviceShare)}%` }}
                        />
                      </div>
                    </>
                  ) : (
                    // Лимит не задан — продавать нечего (см. purchaseVisible).
                    <p className="text-xs text-muted-foreground">
                      {t('pages.subscription.limit.notSet', { used: deviceTotal })}
                    </p>
                  )}
                </div>

                {purchaseVisible && (
                  <div className="px-3 py-3">
                    <p className={labelClass}>{t('pages.subscription.purchase.title')}</p>

                    {/* Липкая плашка после покупки без ответа. Стоит НАД
                        счётчиком, чтобы её нельзя было не заметить, пересчитывая
                        цену. */}
                    {unknownOutcome && (
                      <p className="mt-2 flex gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                        <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                        <span>{t('pages.subscription.purchase.unknownSticky')}</span>
                      </p>
                    )}

                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="min-w-0 text-sm text-foreground">
                        {t('pages.subscription.purchase.count')}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label={t('pages.subscription.purchase.less')}
                          disabled={addCount <= 1 || confirm !== null}
                          onClick={() => setAddCount((prev) => Math.max(1, prev - 1))}
                        >
                          <Minus aria-hidden />
                        </Button>
                        <span
                          className="w-8 text-center text-sm font-semibold tabular-nums text-foreground"
                          aria-live="polite"
                        >
                          {addCount}
                        </span>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label={t('pages.subscription.purchase.more')}
                          disabled={addCount >= stepMax || confirm !== null}
                          onClick={() => setAddCount((prev) => Math.min(stepMax, prev + 1))}
                        >
                          <Plus aria-hidden />
                        </Button>
                      </div>
                    </div>

                    {/* Сервер назвал свой предел — говорим о нём. Про наш
                        интерфейсный предел молчим: сервер принимает и больше,
                        и утверждать «нельзя» было бы неправдой. */}
                    {canAddCap !== undefined && canAddCap > 0 && addCount >= stepMax && (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {t('pages.subscription.purchase.max', { max: stepMax })}
                      </p>
                    )}

                    <div className="mt-2.5" aria-live="polite">
                      {priceView.kind === 'idle' ? (
                        <Button variant="secondary" className="w-full" onClick={askPrice}>
                          {t('pages.subscription.purchase.ask')}
                        </Button>
                      ) : priceView.kind === 'loading' ? (
                        <div className="flex h-8 items-center gap-2.5">
                          <Spinner className="size-3.5 text-muted-foreground" />
                          <span className="text-sm text-muted-foreground">
                            {t('pages.subscription.purchase.asking')}
                          </span>
                        </div>
                      ) : priceView.kind === 'ok' ? (
                        <>
                          <div className="flex items-end justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-xl font-semibold tabular-nums leading-tight text-foreground">
                                {formatKopeks(priceView.quote.priceKopeks)}
                              </p>
                              {/* Объяснение суммы. Без него «1 493 ₽ за
                                  устройство при цене 200 ₽/мес» выглядит
                                  ошибкой приложения, а не прорейтом. */}
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {t('pages.subscription.purchase.forDays', {
                                  count: priceView.quote.daysLeft
                                })}
                              </p>
                            </div>
                            {(priceView.quote.discountPercent ?? 0) > 0 && (
                              <span className="shrink-0 rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-xs font-semibold text-success">
                                {t('pages.subscription.purchase.discount', {
                                  percent: priceView.quote.discountPercent
                                })}
                              </span>
                            )}
                          </div>

                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('pages.subscription.purchase.newLimit', {
                              limit: priceView.quote.newLimit
                            })}
                          </p>

                          {priceView.quote.enough ? (
                            <Button
                              className="mt-2.5 w-full"
                              disabled={confirm !== null}
                              onClick={openConfirm}
                            >
                              {t('pages.subscription.purchase.buy')}
                            </Button>
                          ) : (
                            // ⚠️ Не хватает денег — покупку не отправляем
                            // вовсе. Кнопки «Докупить» здесь нет: вместо неё
                            // пополнение в браузере.
                            <>
                              <p className="mt-2 text-xs text-warning">
                                {t('pages.subscription.purchase.notEnough', {
                                  amount: formatKopeks(
                                    priceView.quote.priceKopeks - priceView.quote.balanceKopeks
                                  )
                                })}
                              </p>
                              <Button
                                variant="secondary"
                                className="mt-2 w-full"
                                onClick={openTopUp}
                              >
                                <Wallet aria-hidden />
                                {t('pages.subscription.purchase.topUp')}
                              </Button>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <p
                            className={cn(
                              'text-xs',
                              priceView.kind === 'unavailable'
                                ? 'text-muted-foreground'
                                : 'text-destructive'
                            )}
                          >
                            {priceFailureText(priceView)}
                          </p>
                          {/* Кнопка по смыслу отказа, а не одна на все:
                              «повторить» на непринятой сессии не поможет никогда, а на
                              отказе продавать (unavailable) кнопки нет вовсе: сервер
                              ответил и не передумает от второго вопроса. */}
                          {priceView.kind === 'failed' &&
                          priceView.failure.state === 'unauthorized' ? (
                            <Button
                              variant="secondary"
                              className="mt-2 w-full"
                              onClick={() => openLogin(true)}
                            >
                              {t('subscription.signIn')}
                            </Button>
                          ) : priceView.kind !== 'unavailable' ? (
                            <Button
                              variant="secondary"
                              className="mt-2 w-full"
                              onClick={() => void loadPrice(addCount)}
                            >
                              {t('pages.home.connectRetry')}
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>

                    {/* Подпись про пересчёт имеет смысл только там, где речь
                        о цене. На отказе цены нет и пересчитывать нечего. */}
                    {(priceView.kind === 'idle' ||
                      priceView.kind === 'loading' ||
                      priceView.kind === 'ok') && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t('pages.subscription.purchase.estimate')}
                      </p>
                    )}
                  </div>
                )}
              </Group>
            )}

            {/* --- Подключённые устройства -----------------------------------
                Строки НАЖИМАЕМЫЕ: всё, что можно сделать с железкой, живёт в
                листе (components/cabinet/device-sheet.tsx), а не в строке.
                Кнопок действий в самой строке нет намеренно — промах мимо
                строки не должен стоить человеку устройства.
                Это не Row: у Row одна строка текста и фиксированные 40 px, а
                здесь две строки (имя и «платформа · активность»). Классы
                наведения и кольцо фокуса взяты у Row один в один, чтобы список
                не выглядел чужим. */}
            <Group title={t('pages.subscription.devices.title')}>
              {/* По отсутствию ответа, а не по флагу загрузки: до первого
                  ответа утверждать «устройств не видно» мы не вправе — мы ещё не
                  спрашивали. */}
              {!devices ? (
                <div className="flex h-10 items-center gap-2.5 px-3">
                  <Spinner className="size-3.5 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {t('pages.subscription.devices.loading')}
                  </span>
                </div>
              ) : devices?.state === 'noSubscription' ? (
                <p className="px-3 py-2.5 text-sm text-muted-foreground">
                  {t('pages.more.subscription.none')}
                </p>
              ) : devices?.state === 'error' ? (
                <>
                  {/* message приходит из main уже переведённым и готовым к показу. */}
                  <p className="px-3 py-2.5 text-xs text-destructive">
                    {devices.message || t('pages.subscription.devices.error')}
                  </p>
                  <Row
                    icon={RefreshCcw}
                    label={t('pages.home.connectRetry')}
                    busy={devicesLoading}
                    disabled={devicesLoading}
                    onClick={() => void loadDevices(true)}
                  />
                </>
              ) : deviceList.length === 0 ? (
                // ⚠️ Сдержанно и в два голоса, потому что 200 + [] кабинет отдаёт и
                // когда устройств действительно нет, и когда ему не ответила
                // панель. Различить по ответу нельзя, поэтому утверждать «устройств
                // нет» мы не вправе — только «не видно», и сразу подсказка, что
                // делать, если человек знает, что устройства есть.
                <div className="px-3 py-2.5">
                  <p className="text-sm text-foreground">
                    {t('pages.subscription.devices.empty')}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('pages.subscription.devices.emptyHint')}
                  </p>
                </div>
              ) : (
                deviceList.map((device, index) => {
                  const Icon = deviceIcon(device.platform)
                  // Подпись по убыванию понятности: имя, которое человек задал сам,
                  // потом модель, потом платформа. Всё пустое или 'Unknown' —
                  // «Без имени», а не заглушка кабинета.
                  const title = !isBlank(device.localName)
                    ? (device.localName ?? '').trim()
                    : !isBlank(device.model)
                      ? device.model.trim()
                      : !isBlank(device.platform)
                        ? device.platform.trim()
                        : t('common.unnamed')
                  const platform = isBlank(device.platform)
                    ? t('pages.subscription.devices.platformUnknown')
                    : device.platform.trim()
                  // ⚠️ lastSeenAt = undefined значит «панель не дала», а не
                  // «давно»: относительное время от нуля показало бы 1970 год.
                  const lastSeen = device.lastSeenAt
                    ? t('pages.subscription.devices.lastSeen', {
                        ago: dayjs(Math.min(device.lastSeenAt, Date.now())).fromNow()
                      })
                    : t('pages.subscription.devices.lastSeenUnknown')

                  // hwid бывает пустым — панель не всегда даёт идентификатор. Тогда
                  // ключ от индекса: список не сортируется и не фильтруется,
                  // переставлять строки нечему.
                  return (
                    <button
                      key={device.hwid || `device-${index}`}
                      type="button"
                      onClick={() => setSelected(device)}
                      className={cn(
                        'flex min-h-12 w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors',
                        'hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary'
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {`${platform} · ${lastSeen}`}
                        </p>
                      </div>
                      {/* Приложение и версия — то, за чем сюда смотрит поддержка:
                          по ним видно, у кого сборка устарела. */}
                      {device.app && (
                        <span className="max-w-[34%] shrink-0 truncate text-xs tabular-nums text-muted-foreground">
                          {device.app}
                        </span>
                      )}
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    </button>
                  )
                })
              )}
            </Group>
          </>
        )}

        {/* Группы «Тариф» здесь больше нет: её две строки — трафик и остаток
            дней — это ровно то, что теперь показывает мера выше, и одно и то же
            число дважды на одном экране только заставляет сверять, совпало ли.
            «Обновить подписку» ушло в кнопку шапки, к строке «Обновлено N
            назад», на вопрос которой оно и отвечает. */}
        <Group title={t('pages.subscription.groupActions')}>
          {cabinetUrl && (
            <Row
              icon={AppWindow}
              label={t('pages.more.subscription.cabinet')}
              trailing="external"
              title={cabinetUrl}
              onClick={() => window.open(cabinetUrl)}
            />
          )}
          {supportUrl && (
            <Row
              icon={HeadsetIcon}
              label={t('pages.more.subscription.support')}
              trailing="external"
              title={supportUrl}
              onClick={() => window.open(supportUrl)}
            />
          )}
          {/* Ни кабинета, ни поддержки сервер может не отдать вовсе — тогда
              группа была бы пустой рамкой. Обновление в этом случае возвращаем
              строкой: иначе у локального профиля, где кнопки в шапке нет,
              экран остаётся совсем без действий. */}
          {!cabinetUrl && !supportUrl && (
            <Row
              icon={RefreshCcw}
              label={t('pages.more.subscription.update')}
              disabled={!canUpdate || updating}
              busy={updating}
              onClick={onUpdate}
            />
          )}
          {/* Выход из аккаунта. Подписку он НЕ трогает: сессия кабинета и
              конфигурация VPN — разные вещи, и человек, отключивший аккаунт,
              не должен остаться без интернета. Строка появляется только когда
              выходить есть из чего. */}
          {signedIn && (
            <Row
              icon={LogOut}
              label={t('pages.subscription.signOut')}
              className="text-destructive"
              onClick={() => setConfirmSignOut(true)}
            />
          )}
        </Group>
      </div>

      {/* РОВНО ОДИН смонтированный лист на весь экран. Два листа на одно
          устройство дали бы второму состояние 'busy' от замка в главном
          процессе (connect.ts:1336). */}
      <DeviceSheet
        open={!!selected}
        device={selected}
        missing={selectedMissing}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        onRename={renameCabinetDevice}
        onForget={removeCabinetDevice}
        onRenamed={refreshDevices}
        // ⚠️ Перечитываем список после ЛЮБОГО исхода отключения, а не только
        // успешного: потерянный ответ на DELETE не означает, что устройство
        // осталось.
        onForgotten={refreshDevices}
        onGone={refreshDevices}
        onSignIn={() => openLogin(true)}
      />

      {confirmSignOut && (
        <ConfirmModal
          title={t('pages.subscription.signOutConfirmTitle')}
          description={
            <p className="text-sm text-muted-foreground">
              {t('pages.subscription.signOutConfirmText')}
            </p>
          }
          confirmText={t('pages.subscription.signOut')}
          cancelText={t('common.cancel')}
          onChange={(open) => {
            if (!open) setConfirmSignOut(false)
          }}
          onConfirm={onSignOut}
        />
      )}

      {/* --- Подтверждение покупки --------------------------------------
          Свой диалог, а НЕ ConfirmModal: там кнопка подтверждения не умеет
          гаснуть и закрывает окно сразу после onConfirm, то есть исход покупки
          человек бы не увидел, а второе нажатие успело бы уйти.

          ⚠️ Вето на закрытие сделано через onEscapeKeyDown/onInteractOutside и
          снятый крестик, а НЕ через игнорирование onOpenChange: обёртка Dialog
          гасит своё внутреннее состояние ДО вызова колбэка (ui/dialog.tsx:27),
          и проигнорированное закрытие оставило бы диалог невидимым, но
          «открытым». */}
      {confirm && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closeConfirm()
          }}
        >
          <DialogContent
            showCloseButton={!sending}
            onEscapeKeyDown={(e) => {
              if (sending) e.preventDefault()
            }}
            onInteractOutside={(e) => {
              if (sending) e.preventDefault()
            }}
            className="w-[min(420px,calc(100%-2rem))] gap-3"
          >
            <DialogHeader>
              <DialogTitle>{confirmTitle(confirm)}</DialogTitle>
              <DialogDescription>{confirmLead}</DialogDescription>
            </DialogHeader>

            <div>{renderConfirmBody(confirm)}</div>

            <DialogFooter className="sm:justify-end">
              {confirm.stage === 'ready' && confirm.quote.enough ? (
                <>
                  <Button variant="ghost" size="sm" onClick={closeConfirm}>
                    {t('common.cancel')}
                  </Button>
                  {/* Сумма стоит НА кнопке: последнее, что человек видит перед
                      нажатием, — это сколько спишется. */}
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => doPurchase(confirm.quote)}
                  >
                    {t('pages.subscription.purchase.confirmBuy', {
                      amount: formatKopeks(confirm.quote.priceKopeks)
                    })}
                  </Button>
                </>
              ) : confirm.stage === 'sending' ? (
                <>
                  <Button variant="ghost" size="sm" disabled>
                    {t('common.cancel')}
                  </Button>
                  <Button variant="destructive" size="sm" disabled aria-busy>
                    <Spinner className="size-3.5" />
                    {t('pages.subscription.purchase.sending')}
                  </Button>
                </>
              ) : confirm.stage === 'quoting' ? (
                <Button variant="ghost" size="sm" onClick={closeConfirm}>
                  {t('common.cancel')}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={closeConfirm}>
                  {t('common.close')}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export default Subscription
