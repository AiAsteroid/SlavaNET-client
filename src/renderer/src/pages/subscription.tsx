import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  AppWindow,
  CreditCard,
  HeadsetIcon,
  InfinityIcon,
  Laptop,
  LogIn,
  LogOut,
  MonitorSmartphone,
  RefreshCcw,
  Smartphone
} from 'lucide-react'
import TitleStrip from '@renderer/components/shell/title-strip'
import { Group, Row } from '@renderer/components/shell/list-group'
import SubscriptionEmptyState from '@renderer/components/profiles/subscription-empty-state'
import ConfirmModal from '@renderer/components/base/base-confirm'
import { Spinner } from '@renderer/components/ui/spinner'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { useLoginStore } from '@renderer/store/login-store'
import { calcTraffic } from '@renderer/utils/calc'
import { disconnectAccount, fetchCabinetDevices, hasCabinetSession } from '@renderer/utils/ipc'
import { splitTariffName } from '@renderer/utils/subscription'
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

  const cabinetUrl = currentProfile?.home
  const supportUrl = currentProfile?.supportUrl
  const canUpdate = !!currentProfile && currentProfile.type === 'remote'

  // Куда вести из карточки, когда подписка кончается. Порядок тот же, что у
  // живой строки на главной (home.tsx:199): свой адрес кабинета, иначе
  // поддержка — оплатить через человека тоже способ.
  const renewAction =
    currentProfile?.homeName && currentProfile?.home
      ? { url: currentProfile.home, label: currentProfile.homeName }
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

  // --- Подключённые устройства ---------------------------------------------

  const [devices, setDevices] = useState<CabinetDevicesResult | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)
  // Ответ приходит после ухода с экрана постоянно: запрос идёт в сеть, а вкладку
  // переключают мгновенно. Без этого флага setState летел бы в размонтированный
  // компонент.
  const aliveRef = useRef(true)

  const devicesKey = `${currentProfile?.id ?? ''}:${currentProfile?.updated ?? 0}`

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

  useEffect(() => {
    aliveRef.current = true
    // Пока профиль не подъехал из SWR, спрашивать нечего: ключ кэша ещё пустой,
    // и запрос ушёл бы впустую, а потом второй раз — с настоящим ключом.
    if (!currentProfile) return undefined
    void loadDevices(false)
    return (): void => {
      aliveRef.current = false
    }
  }, [currentProfile, loadDevices])

  // Вход завершился — перечитать устройства немедленно.
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
      void loadDevices(true)
    }
    window.electron.ipcRenderer.on('subscription-connect-status', onStatus)
    return (): void => {
      window.electron.ipcRenderer.removeAllListeners('subscription-connect-status')
    }
  }, [loadDevices])

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
    // Кэш обязан протухнуть сразу: иначе ещё минуту показывали бы список
    // устройств аккаунта, из которого только что вышли.
    devicesCache = null
    setSignedIn(false)
    await disconnectAccount()
    await loadDevices(true)
  }

  const deviceList = devices?.state === 'ok' ? devices.devices : []
  const deviceLimit = devices?.state === 'ok' ? devices.limit : undefined
  const deviceTotal = devices?.state === 'ok' ? devices.total : 0

  // Занятость в заголовке появляется только когда знаменатель есть. ⚠️ limit
  // отсутствует при device_limit = 0, а это «лимит не задан», а не «ноль
  // устройств»: делить на него нельзя, поэтому просто «Устройства».
  const devicesTitle =
    deviceLimit && deviceLimit > 0
      ? t('pages.subscription.devices.titleCount', { used: deviceTotal, limit: deviceLimit })
      : t('pages.subscription.devices.title')

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

        {/* --- Подключённые устройства -----------------------------------
            ⚠️ Строки устройств — обычные div, а не Row: Row это <button>, а
            удаление устройств из клиента мы не делаем (это действие кабинета),
            и кнопка, которая ничего не делает, но ловит фокус и подсвечивается
            под курсором, врёт про себя. Rowʼом остаются только те строки,
            которые действительно нажимаются: «Войти» и «Попробовать снова».
            Рамку и разделители по-прежнему рисует Group, поэтому список выглядит
            ровно как остальные группы экрана. */}
        <Group title={devicesTitle}>
          {devicesLoading && !devices ? (
            <div className="flex h-10 items-center gap-2.5 px-3">
              <Spinner className="size-3.5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {t('pages.subscription.devices.loading')}
              </span>
            </div>
          ) : devices?.state === 'unauthorized' ? (
            // ⚠️ Именно «нужен вход», а НЕ «устройств нет». hasCabinetSession()
            // в этот момент может всё ещё отвечать true (main не стирает сессию
            // из-за одного отказа), поэтому решение принимаем по state.
            <>
              <p className="px-3 py-2.5 text-xs text-muted-foreground">
                {t('pages.subscription.devices.signInHint')}
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
            </>
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
                    ago: dayjs(device.lastSeenAt).fromNow()
                  })
                : t('pages.subscription.devices.lastSeenUnknown')

              // hwid бывает пустым — панель не всегда даёт идентификатор. Тогда
              // ключ от индекса: список не сортируется и не фильтруется,
              // переставлять строки нечему.
              return (
                <div
                  key={device.hwid || `device-${index}`}
                  className="flex min-h-12 items-center gap-2.5 px-3 py-2"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {`${platform} · ${lastSeen}`}
                    </p>
                  </div>
                  {/* Приложение и версия — то, за чем сюда смотрит поддержка:
                      по ним видно, у кого сборка устарела. Справа и тихо, без
                      нажатия: ничего сделать с устройством отсюда нельзя. */}
                  {device.app && (
                    <span className="max-w-[38%] shrink-0 truncate text-xs tabular-nums text-muted-foreground">
                      {device.app}
                    </span>
                  )}
                </div>
              )
            })
          )}
        </Group>

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
    </div>
  )
}

export default Subscription
