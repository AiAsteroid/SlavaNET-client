import { toast } from 'sonner'
import TitleStrip from '@renderer/components/shell/title-strip'
import ServerList from '@renderer/components/connect/server-list'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { triggerSysProxy, updateTrayIcon, mihomoHotReloadConfig } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import { memo, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  InfinityIcon,
  ArrowUp,
  ArrowDown,
  RefreshCcw,
  CalendarClock,
  CreditCard,
  Power,
  Pause
} from 'lucide-react'
import EditInfoModal from '@renderer/components/profiles/edit-info-modal'
import SubscriptionEmptyState from '@renderer/components/profiles/subscription-empty-state'
import { CharacterMorph } from '@renderer/components/ui/character-morph'
import { cn } from '@renderer/lib/utils'
import { calcTraffic } from '@renderer/utils/calc'
import { useTrafficStore } from '@renderer/store/traffic-store'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

// Days left at which the subscription row turns red and offers renewal
const EXPIRY_WARNING_DAYS = 3

// Module-level variable: persists across component mounts/unmounts
let connectionStartTime: number | null = null

const ConnectedTimer = memo(({ active }: { active: boolean }) => {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!active) {
      connectionStartTime = null
      setElapsed(0)
      return undefined
    }

    if (connectionStartTime === null) {
      connectionStartTime = Date.now()
    }

    const updateElapsed = (): void => {
      setElapsed(Math.floor((Date.now() - connectionStartTime!) / 1000))
    }
    updateElapsed()
    const interval = setInterval(updateElapsed, 1000)
    return () => clearInterval(interval)
  }, [active])

  const hours = Math.floor(elapsed / 3600)
  const minutes = Math.floor((elapsed % 3600) / 60)
  const seconds = elapsed % 60
  return (
    <span>
      {String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:
      {String(seconds).padStart(2, '0')}
    </span>
  )
})
ConnectedTimer.displayName = 'ConnectedTimer'

// Экран «Подключение» — единственный экран, на котором человек проводит время.
//
// Владелец выбрал вариант «один экран»: сверху кнопка со статусом, под ней одна
// тонкая строка подписки, а всё остальное место отдано списку серверов, потому
// что выбор узла — это то, зачем сюда заходят чаще всего. Поэтому на кнопку и
// подписку тратится фиксированная высота, а растёт только список.
//
// ⚠️ Полосу из трёх колонок («Трафика осталось / Дней осталось / Истекает»),
// объявление провайдера, строку выбора узла с шевроном и ссылку «Поддержка»
// убрали осознанно: втроём они занимали весь экран ради данных, которые смотрят
// раз в месяц. Данные не потеряны — цифры сжаты в одну строку, остальное ушло в
// подсказку строки и в раздел «Ещё».
//
// ⚠️ Логика включения, выбор режима tun/sysproxy, таймер, подсчёт трафика и
// предупреждение об окончании подписки перенесены без изменений поведения: это
// работающая часть, менялась только оболочка вокруг неё.
const Home: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    mainSwitchMode = 'tun',
    sysProxy,
    proxyMode = false,
    onlyActiveDevice = false
  } = appConfig || {}
  const { enable: writeSysProxy = true, mode } = sysProxy || {}
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { tun } = controledMihomoConfig || {}
  const { 'mixed-port': mixedPort } = controledMihomoConfig || {}
  const sysProxyDisabled = mixedPort == 0

  const { profileConfig, addProfileItem } = useProfileConfig()
  const hasProfiles = (profileConfig?.items?.length ?? 0) > 0
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingItem, setEditingItem] = useState<ProfileItem | null>(null)
  const [updating, setUpdating] = useState(false)

  const handleAddProfile = (): void => {
    const newProfile: ProfileItem = {
      id: '',
      name: '',
      type: 'remote',
      url: '',
      useProxy: false,
      autoUpdate: true
    }
    setEditingItem(newProfile)
    setShowEditModal(true)
  }

  const trafficInfo = useTrafficStore((s) => s.traffic)

  const [loading, setLoading] = useState(false)
  const [loadingDirection, setLoadingDirection] = useState<'connecting' | 'disconnecting'>(
    'connecting'
  )

  const isSelected = (tun?.enable ?? false) || proxyMode

  const isDisabled =
    loading ||
    (mainSwitchMode === 'sysproxy' && writeSysProxy && mode == 'manual' && sysProxyDisabled)

  const status = loading
    ? loadingDirection === 'connecting'
      ? t('pages.home.connecting')
      : t('pages.home.disconnecting')
    : isSelected
      ? t('pages.home.connected')
      : t('pages.home.disconnected')
  const statusWidthTexts = [
    t('pages.home.connecting'),
    t('pages.home.disconnecting'),
    t('pages.home.connected'),
    t('pages.home.disconnected')
  ]
  const showConnectedTimer = !loading && isSelected

  // Current profile & subscription
  const currentProfile = useMemo(() => {
    if (!profileConfig?.current || !profileConfig?.items) return null
    return profileConfig.items.find((item) => item.id === profileConfig.current) ?? null
  }, [profileConfig])

  const handleUpdateProfile = async (): Promise<void> => {
    if (!currentProfile || updating) return
    setUpdating(true)
    try {
      await addProfileItem(currentProfile)
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      setUpdating(false)
    }
  }

  const subscription = currentProfile?.extra
  const trafficUsed = (subscription?.upload ?? 0) + (subscription?.download ?? 0)
  const trafficTotal = subscription?.total ?? 0
  const trafficRemaining = trafficTotal > 0 ? trafficTotal - trafficUsed : 0
  const expireTimestamp = subscription?.expire ?? 0
  const expireDate =
    expireTimestamp > 0 ? dayjs.unix(expireTimestamp).format('L') : t('pages.home.never')

  // Re-evaluate the countdown while the window stays open so the notice appears on time
  const [expiryTick, setExpiryTick] = useState(0)
  useEffect(() => {
    if (expireTimestamp <= 0) return undefined
    const interval = setInterval(() => setExpiryTick((n) => n + 1), 60_000)
    return () => clearInterval(interval)
  }, [expireTimestamp])

  const { daysRemaining, isExpired } = useMemo(() => {
    if (expireTimestamp <= 0) return { daysRemaining: 0, isExpired: false }
    const expiresAt = dayjs.unix(expireTimestamp)
    return {
      daysRemaining: Math.max(0, expiresAt.diff(dayjs(), 'day')),
      isExpired: expiresAt.isBefore(dayjs())
    }
  }, [expireTimestamp, expiryTick])

  const showExpiryNotice = expireTimestamp > 0 && daysRemaining <= EXPIRY_WARNING_DAYS
  const renewAction =
    currentProfile?.homeName && currentProfile?.home
      ? { url: currentProfile.home, label: currentProfile.homeName }
      : currentProfile?.supportUrl
        ? { url: currentProfile.supportUrl, label: t('pages.home.renewSubscription') }
        : null
  const expiryTitle = isExpired
    ? t('pages.home.subscriptionExpired')
    : daysRemaining === 0
      ? t('pages.home.subscriptionExpiringToday')
      : t('pages.home.subscriptionExpiring', { count: daysRemaining })

  // Строка подписки высотой 44 не вмещает ни объявление провайдера, ни три
  // подписанных цифры. Они не выброшены: полный текст висит подсказкой строки,
  // так что «сколько осталось» и «что пишет провайдер» по-прежнему доступны, но
  // не занимают пол-экрана.
  const rowTooltip = useMemo(() => {
    if (!currentProfile) return undefined
    const lines: string[] = [currentProfile.name]
    if (subscription) {
      lines.push(
        `${t('pages.home.trafficRemaining')} ${
          trafficTotal > 0 ? formatBytes(trafficRemaining) : t('pages.home.unlimited')
        }`
      )
      lines.push(
        `${t('pages.home.daysRemaining')} ${
          expireTimestamp > 0 ? daysRemaining : t('pages.home.unlimited')
        }`
      )
      lines.push(`${t('pages.home.expires')} ${expireDate}`)
    }
    if (showExpiryNotice) {
      lines.push(
        isExpired
          ? t('pages.home.subscriptionExpiredHint')
          : t('pages.home.subscriptionExpiringHint', { date: expireDate })
      )
    }
    if (currentProfile.announce) lines.push(currentProfile.announce)
    return lines.join('\n')
  }, [
    currentProfile,
    subscription,
    trafficTotal,
    trafficRemaining,
    expireTimestamp,
    daysRemaining,
    expireDate,
    showExpiryNotice,
    isExpired,
    t
  ])

  const onValueChange = async (enable: boolean): Promise<void> => {
    setLoading(true)
    setLoadingDirection(enable ? 'connecting' : 'disconnecting')
    try {
      if (enable) {
        if (mainSwitchMode === 'tun') {
          await patchControledMihomoConfig({ tun: { enable: true }, dns: { enable: true } })
          await mihomoHotReloadConfig()
        } else {
          if (writeSysProxy && mode == 'manual' && sysProxyDisabled) return
          await patchAppConfig({ proxyMode: true })
          await mihomoHotReloadConfig()
          if (writeSysProxy) {
            await triggerSysProxy(true, onlyActiveDevice)
          }
        }
      } else {
        const tunWasEnabled = tun?.enable ?? false
        const proxyModeWasEnabled = proxyMode
        if (tunWasEnabled) {
          await patchControledMihomoConfig({ tun: { enable: false } })
        }
        if (proxyModeWasEnabled) {
          if (writeSysProxy) {
            await triggerSysProxy(false, onlyActiveDevice)
          }
          await patchAppConfig({ proxyMode: false })
        }
        if (tunWasEnabled || proxyModeWasEnabled) {
          await mihomoHotReloadConfig()
        }
      }
      window.electron.ipcRenderer.send('updateFloatingWindow')
      window.electron.ipcRenderer.send('updateTrayMenu')
      await updateTrayIcon()
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      setLoading(false)
    }
  }

  const refreshButton =
    currentProfile?.type === 'remote' ? (
      <button
        type="button"
        onClick={handleUpdateProfile}
        disabled={updating}
        aria-label={t('common.update')}
        title={t('common.update')}
        aria-busy={updating}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)] disabled:pointer-events-none disabled:opacity-40"
      >
        <RefreshCcw className={cn('size-3.5', updating && 'animate-spin')} />
      </button>
    ) : null

  return (
    // --sn-accent и --sn-on живут на корне экрана: зелёный «включено» и синий
    // акцент заданы решением владельца литералами, общего токена под них в
    // @theme нет. Появится — менять здесь в одном месте.
    <div className="flex h-full min-h-0 flex-col overflow-hidden [--sn-accent:#2563eb] [--sn-on:#22c55e] dark:[--sn-accent:#3b82f6]">
      {/* Заголовка на корневом экране нет: полоса нужна только чтобы тащить окно
          и не дать содержимому залезть под системный светофор. */}
      <TitleStrip />

      {!hasProfiles ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center px-5"
          style={{ paddingBottom: 'var(--nav-space)' }}
        >
          <SubscriptionEmptyState onManual={handleAddProfile} guideAnchor />
          {showEditModal && editingItem && (
            <EditInfoModal
              item={editingItem}
              isCurrent={false}
              updateProfileItem={async (item: ProfileItem) => {
                await addProfileItem(item)
                setShowEditModal(false)
                setEditingItem(null)
              }}
              onClose={() => {
                setShowEditModal(false)
                setEditingItem(null)
              }}
            />
          )}
        </div>
      ) : (
        // min-h-0 на колонке обязателен: без него список серверов растянет
        // колонку по своему содержимому и прокручиваться начнёт весь экран.
        // Резерв снизу — под плавающую капсулу; ServerList своего не добавляет.
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 px-5"
          style={{ paddingBottom: 'var(--nav-space)' }}
        >
          {/* --- Кнопка включения ------------------------------------------ */}
          <div className="flex shrink-0 flex-col items-center pt-1">
            {/* Высота строки статуса зафиксирована всегда: иначе появление
                таймера и смена текста дёргали бы кнопку по вертикали. */}
            <div className="flex h-4 items-center justify-center">
              <CharacterMorph
                texts={[status]}
                reserveTexts={statusWidthTexts}
                interval={3000}
                className="text-xs font-semibold uppercase leading-none tracking-[0.08em] text-muted-foreground"
              />
            </div>

            <button
              type="button"
              disabled={isDisabled}
              onClick={() => onValueChange(!isSelected)}
              data-guide="home-power-toggle"
              aria-pressed={isSelected}
              aria-busy={loading}
              aria-label={isSelected ? t('pages.home.connected') : t('pages.home.disconnected')}
              className="relative mt-3 size-32 cursor-pointer rounded-full outline-none transition-transform active:scale-95 focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-60"
            >
              {/* Выключено — нейтральная заливка с обводкой: красный круг на
                  macOS читается как «опасно, не нажимай», хотя нажать надо
                  именно его. Цветом отмечено только включённое состояние. */}
              <div
                className={cn(
                  'flex size-32 items-center justify-center rounded-full border-2 backdrop-blur-xl transition-colors duration-300',
                  isSelected ? '' : 'border-stroke bg-card/60 text-foreground'
                )}
                style={
                  isSelected
                    ? {
                        // Зелёная заливка плотная, а иконка тёмная: белое по
                        // #22c55e даёт 2.3:1 (об этом же предупреждение в
                        // main.css у --success-foreground), а полупрозрачная
                        // зелень по «шампани» выцветает до неразличимой.
                        borderColor: 'var(--sn-on)',
                        background:
                          'radial-gradient(at 30% 45%, var(--sn-on), color-mix(in oklab, var(--sn-on) 76%, #06140b))',
                        boxShadow: '0 8px 30px color-mix(in oklab, var(--sn-on) 32%, transparent)',
                        color: '#06140b'
                      }
                    : undefined
                }
              >
                {/* Иконки взяты из lucide вместо прежних svg-файлов: в тех
                    белый #FAFAFA зашит в stroke, и на светлой «шампани» они
                    исчезали. currentColor красится темой.
                    Обе лежат друг на друге в общей рамке и меняются
                    прозрачностью: иначе кадр переключения дёргал бы размер. */}
                <div className="relative size-14">
                  <Pause
                    className={cn(
                      'absolute inset-0 size-14 transition-all duration-300 ease-out',
                      !loading && isSelected ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
                    )}
                    strokeWidth={2.2}
                    aria-hidden
                  />
                  <Power
                    className={cn(
                      'absolute inset-0 size-14 transition-all duration-300 ease-out',
                      !loading && !isSelected ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
                    )}
                    strokeWidth={2.2}
                    aria-hidden
                  />
                </div>
              </div>

              {/* В переходе крутится дуга по краю кнопки, а не спиннер внутри:
                  иконка остаётся на месте, и видно, что занята именно кнопка.
                  Длина дуги — четверть окружности 2π·62 ≈ 390. */}
              {loading && (
                <svg
                  viewBox="0 0 128 128"
                  className="absolute inset-0 size-32 animate-spin"
                  aria-hidden
                >
                  <circle
                    cx="64"
                    cy="64"
                    r="62"
                    fill="none"
                    stroke="var(--sn-accent)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray="97 293"
                  />
                </svg>
              )}
            </button>

            {/* Обе строки под кнопкой держат высоту и в выключенном состоянии:
                они появляются и исчезают прозрачностью, а не потоком. */}
            <div className="mt-3 flex h-6 items-center justify-center">
              <div
                aria-hidden={!showConnectedTimer}
                className={cn(
                  'text-lg font-semibold leading-5 text-foreground tabular-nums transition-all duration-300 ease-out',
                  showConnectedTimer ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                )}
              >
                <ConnectedTimer active={isSelected} />
              </div>
            </div>
            <div
              aria-hidden={!showConnectedTimer}
              className={cn(
                'mt-1 flex h-4 items-center gap-3 text-xs tabular-nums text-muted-foreground transition-all duration-300 ease-out',
                showConnectedTimer ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
              )}
            >
              <span className="flex items-center gap-1">
                <ArrowUp className="size-3 text-[color:var(--sn-on)]" aria-hidden />
                {calcTraffic(trafficInfo.upTotal)}
              </span>
              <span className="h-2.5 w-px bg-stroke" />
              <span className="flex items-center gap-1">
                <ArrowDown className="size-3 text-[color:var(--sn-on)]" aria-hidden />
                {calcTraffic(trafficInfo.downTotal)}
              </span>
            </div>
          </div>

          {/* --- Предупреждение об истечении ------------------------------
              Сведений о тарифе на главном экране нет: он про подключение, а
              подписка живёт своим разделом в капсуле (решение владельца
              30.09.2026). Исключение одно — когда подписка вот-вот кончится:
              промолчать об этом значит дать человеку остаться без доступа. */}
          {currentProfile && showExpiryNotice && (
            <div
              data-guide="home-profile-header"
              role={showExpiryNotice ? 'status' : undefined}
              title={rowTooltip}
              className={cn(
                'flex h-11 shrink-0 items-center gap-2 rounded-xl border px-2.5',
                'backdrop-blur-xl transition-colors',
                showExpiryNotice
                  ? 'border-destructive/40 bg-destructive/10'
                  : 'border-stroke bg-card/60'
              )}
            >
              {showExpiryNotice ? (
                <>
                  <CalendarClock className="size-4 shrink-0 text-destructive" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-destructive">
                    {expiryTitle}
                  </span>
                  {/* Кнопка продления — единственное действие, которое в этот
                      момент имеет смысл, поэтому стоит прямо в строке. */}
                  {renewAction && (
                    <button
                      type="button"
                      onClick={() => open(renewAction.url)}
                      className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-destructive/40 px-2 text-xs font-semibold text-destructive outline-none transition-colors hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)]"
                    >
                      <CreditCard className="size-3.5 shrink-0" aria-hidden />
                      <span className="max-w-28 truncate">{renewAction.label}</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  {currentProfile.logo && (
                    <img
                      src={currentProfile.logo}
                      alt=""
                      className="size-5 shrink-0 rounded-full"
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.display = 'none'
                      }}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {currentProfile.name}
                  </span>
                  {/* Остаток трафика и дней — одной строкой цифр. Бесконечность
                      значком: «Безлимит» словом в эту ширину не влезает. */}
                  {subscription && (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                      {trafficTotal > 0 ? (
                        <span>{formatBytes(trafficRemaining)}</span>
                      ) : (
                        <InfinityIcon className="size-3.5" aria-hidden />
                      )}
                      <span className="h-2.5 w-px bg-stroke" />
                      {/* profile.dayShort — уже существующий короткий «д»,
                          ровно так же его склеивает карточка профиля
                          (profile-item.tsx:120). Новый ключ под это не нужен. */}
                      {expireTimestamp > 0 ? (
                        <span>
                          {daysRemaining}
                          {t('profile.dayShort')}
                        </span>
                      ) : (
                        <InfinityIcon className="size-3.5" aria-hidden />
                      )}
                    </span>
                  )}
                </>
              )}
              {refreshButton}
            </div>
          )}

          {/* --- Список серверов ------------------------------------------ */}
          <ServerList />
        </div>
      )}
    </div>
  )
}

export default Home
