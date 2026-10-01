import { toast } from 'sonner'
import TitleStrip from '@renderer/components/shell/title-strip'
import ServerList from '@renderer/components/connect/server-list'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import {
  checkCorePermission,
  manualGrantCorePermition,
  mihomoHotReloadConfig,
  restartCore,
  triggerSysProxy,
  updateTrayIcon
} from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { memo, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  InfinityIcon,
  ArrowUp,
  ArrowDown,
  RefreshCcw,
  CreditCard,
  Power,
  Pause
} from 'lucide-react'
import EditInfoModal from '@renderer/components/profiles/edit-info-modal'
import ConfirmModal from '@renderer/components/base/base-confirm'
import SubscriptionEmptyState from '@renderer/components/profiles/subscription-empty-state'
import { CharacterMorph } from '@renderer/components/ui/character-morph'
import { cn } from '@renderer/lib/utils'
import { calcTraffic } from '@renderer/utils/calc'
import { providerPage, splitTariffName } from '@renderer/utils/subscription'
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
  const navigate = useNavigate()
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

  // Режим TUN требует, чтобы у двоичного файла ядра были права root. Без них
  // ядро пишет в лог «configure tun interface: operation not permitted», а
  // обработчик в main/core/manager.ts:219 молча возвращает tun в выключенное
  // состояние. Снаружи это выглядит как мёртвая кнопка — именно так и выглядело.
  const [needsCorePermission, setNeedsCorePermission] = useState(false)
  const [granting, setGranting] = useState(false)

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
    currentProfile?.homeName && providerPage(currentProfile)
      ? { url: providerPage(currentProfile) as string, label: currentProfile.homeName }
      : currentProfile?.supportUrl
        ? { url: currentProfile.supportUrl, label: t('pages.home.renewSubscription') }
        : null
  const expiryTitle = isExpired
    ? t('pages.home.subscriptionExpired')
    : daysRemaining === 0
      ? t('pages.home.subscriptionExpiringToday')
      : t('pages.home.subscriptionExpiring', { count: daysRemaining })

  // Лимит трафика есть только когда есть от чего считать. При total <= 0
  // (безлимит — основной случай владельца) полоса расхода была бы ложью:
  // делить не на что, а пустая шкала читается как «трафик кончился».
  const hasTrafficLimit = trafficTotal > 0
  const usedShare = hasTrafficLimit
    ? Math.min(100, Math.round((trafficUsed / trafficTotal) * 100))
    : 0
  // Пороги те же, что на странице подписки (subscription.tsx:60): иначе один и
  // тот же остаток красился бы на двух экранах по-разному.
  const usedShareColor =
    usedShare >= 90 ? 'bg-destructive' : usedShare >= 70 ? 'bg-warning' : 'bg-primary'

  // Имя и чип состояния — из общего splitTariffName, того же, которым живёт
  // страница подписки. Копии здесь быть не должно: эвристика разбора хвоста
  // названия держится на договорённости с кабинетом, и когда панель отдаст
  // свой заголовок статуса, править надо будет одно место.
  const { name: tariffName, status: tariffStatus } = splitTariffName(currentProfile?.name)
  // Запасная буква для знака — первая от названия тарифа, а не зашитая «S»:
  // профиль может быть и не наш.
  const tariffInitial = (tariffName || 'S').charAt(0).toUpperCase()
  // Чип: у истекающей подписки состояние важнее названия тарифа, поэтому
  // разобранный хвост («Active») уступает место сроку.
  const stateChip = isExpired
    ? t('pages.more.subscription.expired')
    : showExpiryNotice
      ? t('pages.home.statusExpiring')
      : tariffStatus

  // Строка высотой 52 не вмещает ни объявление провайдера, ни три подписанных
  // цифры. Они не выброшены: полный текст висит подсказкой строки, так что
  // «сколько осталось» и «что пишет провайдер» по-прежнему доступны, но не
  // занимают пол-экрана.
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
      // Словесный отсчёт («Подписка закончится через 2 дня») в самой строке
      // больше не выводится — там стоят чип и плитка срока. Текст не потерян:
      // он первой строкой подсказки, вместе с советом продлить.
      lines.push(expiryTitle)
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
    expiryTitle,
    t
  ])

  // Выдать ядру права и сразу включить VPN: человек нажал кнопку включения,
  // а не «настроить разрешения», и возвращать его к той же кнопке невежливо.
  const grantAndConnect = async (): Promise<void> => {
    if (granting) return
    setGranting(true)
    try {
      await manualGrantCorePermition(['mihomo'])
      // Сокет ядра выбирается по правам ПРИ ЗАПУСКЕ (main/utils/dirs.ts:68),
      // поэтому без перезапуска ядро продолжит слушать «безправный» сокет.
      await restartCore()
      setNeedsCorePermission(false)
      await onValueChange(true)
    } catch (e) {
      // Отказ от ввода пароля — это не ошибка, человек передумал.
      const text = `${e}`
      if (!text.includes('User cancelled') && !text.includes('UserCancelled')) {
        toast.error(text)
      }
      setNeedsCorePermission(false)
    } finally {
      setGranting(false)
    }
  }

  const onValueChange = async (enable: boolean): Promise<void> => {
    setLoading(true)
    setLoadingDirection(enable ? 'connecting' : 'disconnecting')
    try {
      if (enable) {
        if (mainSwitchMode === 'tun') {
          // Спрашиваем ДО включения, а не разбираем отказ после: ядро, у
          // которого нет прав, просто не поднимет интерфейс, а конфигурация к
          // тому моменту уже будет переписана.
          const permission = await checkCorePermission().catch(() => null)
          if (permission && permission.mihomo === false) {
            setNeedsCorePermission(true)
            return
          }
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
        className="relative z-10 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)] disabled:opacity-40"
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
        //
        // ⚠️ Резерва снизу под капсулу здесь НЕТ: колонка доходит до низа окна,
        // чтобы список уезжал под стекло и растворялся. Запас под панель держит
        // сам ServerList, в отступе своей области прокрутки.
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5">
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
              {/* Ореол. Лежит ПОД кнопкой и шире её: в концепте именно он даёт
                  включённому состоянию вес, которого не добирает одна заливка.
                  Только во включённом — в выключенном светиться нечему. */}
              {isSelected && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-8 rounded-full"
                  style={{
                    background:
                      'radial-gradient(closest-side, color-mix(in oklab, var(--sn-on) 16%, transparent), transparent 72%)'
                  }}
                />
              )}

              {/* Выключено — нейтральная заливка с обводкой: красный круг на
                  macOS читается как «опасно, не нажимай», хотя нажать надо
                  именно его. Цветом отмечено только включённое состояние.
                  Обводка в волос, а не 2px: толстый край спорил с заливкой и
                  делал кнопку похожей на пустую рамку. */}
              <div
                className={cn(
                  'flex size-32 items-center justify-center rounded-full transition-colors duration-300',
                  isSelected ? '' : 'hair-ring bg-card text-foreground'
                )}
                style={
                  isSelected
                    ? {
                        // Зелёная заливка плотная, а иконка тёмная: белое по
                        // #22c55e даёт 2.3:1 (об этом же предупреждение в
                        // main.css у --success-foreground), а полупрозрачная
                        // зелень по «шампани» выцветает до неразличимой.
                        background:
                          'radial-gradient(at 30% 42%, var(--sn-on), color-mix(in oklab, var(--sn-on) 72%, #06140b) 78%)',
                        // Три тени разом: мягкий сброс вниз, светлая кромка
                        // сверху и затемнение снизу внутри — круг получает
                        // объём без единой нарисованной линии.
                        boxShadow:
                          '0 12px 48px color-mix(in oklab, var(--sn-on) 44%, transparent), inset 0 1px 0 rgb(255 255 255 / 30%), inset 0 -10px 26px rgb(6 20 11 / 22%)',
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

          {/* --- Живая строка подписки ------------------------------------
              Решение владельца 30.09.2026: строка стоит на ГЛАВНОЙ, над списком
              серверов — «так всегда будет понятно». Прежний блок предупреждения
              об истечении отсюда убран: строка сама умеет это состояние, и два
              блока об одном и том же на одном экране не нужны. Полная мера
              тарифа (цена, устройства, шкала с подписями) живёт на странице
              подписки — здесь только «кто, сколько осталось, до какого числа».

              Состояние задано двумя локальными переменными на корне строки:
              --sn-row — акцентная семья (синий / красный), --sn-live — семья
              «живого» индикатора (зелёный / красный). Поэтому ниже почти нет
              развилок по состоянию: перекрасить строку — поменять две строки
              здесь, а не восемь классов по всей разметке. */}
          {currentProfile && (
            <div
              data-guide="home-profile-header"
              role={showExpiryNotice ? 'status' : undefined}
              title={rowTooltip}
              className={cn(
                'relative flex shrink-0 items-center gap-2.5 rounded-xl px-2 transition-colors',
                // 52 — базовая высота. При лимите строка вырастает до 56 и
                // отдаёт нижние 6px полосе трафика: иначе полоса села бы на
                // текст. Безлимит — основной случай владельца — остаётся на 52.
                hasTrafficLimit ? 'h-14 pb-1.5' : 'h-13',
                // Обычное состояние — просто карточка, без края: от фона её
                // отделяет заливка (см. «Ступень светлее» в main.css). Истекающая подписка край
                // сохраняет, но волосяной: красная рамка здесь не украшение,
                // а единственная тревога на экране.
                showExpiryNotice
                  ? 'bg-destructive/12 [--sn-live:var(--destructive)] [--sn-row:var(--destructive)]'
                  : 'bg-card hover:bg-accent [--sn-live:var(--success)] [--sn-row:var(--sn-accent)]'
              )}
              style={{
                // Слабый подсвет слева — он отделяет строку от карточек списка,
                // у которых фон такой же. Держим на --sn-row, чтобы красное
                // состояние не пришлось красить отдельным правилом.
                // ⚠️ На светлой «шампани» синий подсвет почти не виден (о синем
                // по шампани предупреждает main.css:67). Это допустимо: подсвет
                // здесь украшение, ни одного смысла на нём не висит.
                backgroundImage:
                  'radial-gradient(130% 220% at 0% 50%, color-mix(in oklab, var(--sn-row) 12%, transparent), transparent 62%)',
                // Край только у тревоги, внутренней тенью на --sn-row.
                // ⚠️ Не через переопределение --stroke: он наследуется внутрь
                // строки, и любой потомок с bg-stroke позже молча покраснел бы
                // вместе с ней. На «Подписке» этим уже обожглись.
                boxShadow: showExpiryNotice
                  ? 'inset 0 0 0 var(--hairline) color-mix(in oklab, var(--sn-row) 45%, transparent)'
                  : undefined
              }}
            >
              {/* Вся строка ведёт в раздел «Подписка». Кликабельная зона — это
                  отдельная кнопка поверх строки, а не onClick на контейнере:
                  внутри уже стоят свои кнопки, а <button> в <button> вкладывать
                  нельзя. Кнопки действий лежат выше по z-index, поэтому их
                  нажатия до этой кнопки не доходят и stopPropagation не нужен.
                  ⚠️ Кликабельность ничем не подписана: шеврон не поставлен,
                  чтобы не спорить с кнопкой обновления справа. Заметно только по
                  наведению — это осознанный размен из концепта. */}
              <button
                type="button"
                onClick={() => navigate('/subscription')}
                aria-label={t('shell.navSubscription')}
                className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)]"
              />

              {/* Знак подписки. Логотип провайдера, если он пришёл, иначе первая
                  буква названия. Буква лежит в кругу всегда, а картинка — поверх
                  неё, поэтому битая ссылка просто открывает букву и не оставляет
                  дыру. pointer-events-none обязателен: знак спозиционирован и без
                  этого перехватывал бы клики у кнопки-подложки. */}
              <div
                aria-hidden
                className="pointer-events-none relative flex size-[30px] shrink-0 items-center justify-center rounded-full border border-[color:color-mix(in_oklab,var(--sn-row)_38%,transparent)] text-sm font-bold leading-none text-foreground"
                style={{
                  background:
                    'radial-gradient(at 32% 28%, color-mix(in oklab, var(--sn-row) 34%, transparent), color-mix(in oklab, var(--sn-row) 10%, transparent))'
                }}
              >
                {tariffInitial}
                {currentProfile.logo && (
                  <img
                    src={currentProfile.logo}
                    alt=""
                    className="absolute inset-0 size-full rounded-full object-cover"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                )}

                {/* Точка состояния — то самое «живое»: мягкий ритм 2.6s, а не
                    мерцание. Пульс рисует отдельное кольцо animate-ping, потому
                    что своих @keyframes под это в main.css заводить нельзя (файл
                    не наш), а ping даёт ровно тот же смысл. Прозрачность кольца
                    задана цветом, а не opacity-*: ping сам гонит opacity от 1 к 0
                    и утилиту бы перебил.
                    ⚠️ motion-reduce убирает кольцо целиком. Это единственная
                    анимация на экране, которая идёт постоянно, даже когда VPN
                    выключен, — для «уменьшить движение» первый кандидат. */}
                <span className="absolute -right-px -bottom-px flex size-[9px] items-center justify-center">
                  <span className="absolute size-full animate-ping rounded-full bg-[color:color-mix(in_oklab,var(--sn-live)_55%,transparent)] [animation-duration:2.6s] motion-reduce:hidden" />
                  <span className="relative size-full rounded-full border-2 border-card bg-[color:var(--sn-live)]" />
                </span>
              </div>

              {/* Центр — единственная тянущаяся зона строки. min-w-0 обязателен:
                  без него длинное имя тарифа не обрежется, а растянет строку и
                  выдавит плитку срока за край. */}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {tariffName || t('pages.more.subscription.none')}
                  </span>
                  {stateChip && (
                    <span className="flex h-[17px] shrink-0 items-center rounded-full border border-[color:color-mix(in_oklab,var(--sn-live)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--sn-live)_14%,transparent)] px-1.5 text-xs font-semibold leading-none text-[color:var(--sn-live)]">
                      {stateChip}
                    </span>
                  )}
                </div>

                <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs tabular-nums text-muted-foreground">
                  {/* При безлимите главная величина строки — не трафик, а срок.
                      Поэтому «Безлимит» здесь только подсвечен весом и цветом, а
                      крупным кеглем набрано число дней справа. */}
                  <span className="shrink-0 font-semibold text-foreground/85">
                    {hasTrafficLimit ? formatBytes(trafficRemaining) : t('pages.home.unlimited')}
                  </span>
                  {hasTrafficLimit && (
                    <span className="shrink-0">{t('pages.subscription.trafficLeft')}</span>
                  )}
                  {expireTimestamp > 0 && (
                    <>
                      <span
                        aria-hidden
                        className="size-[3px] shrink-0 rounded-full bg-muted-foreground opacity-50"
                      />
                      <span className="truncate">
                        {t('pages.subscription.until', { date: expireDate })}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Плитка срока — единственный крупный кегль в строке: при
                  безлимите трафика (основной случай владельца) остаётся ровно
                  одно число, за которое цепляется глаз.
                  ⚠️ Бессрочная подписка (expire = 0) обязана показывать ∞: «0 дн»
                  на ней было бы прямой ложью. */}
              <div
                className={cn(
                  'flex h-8 shrink-0 items-center rounded-md px-[9px]',
                  // Плитка — третья ступень: фон -> карточка -> плитка. Раньше
                  // она была долей от текста (bg-foreground/6) и на светлой
                  // теме уходила в грязно-серый.
                  showExpiryNotice ? 'bg-destructive/15' : 'bg-secondary'
                )}
              >
                {expireTimestamp > 0 ? (
                  <span className="flex items-baseline gap-[3px]">
                    <span
                      className={cn(
                        'text-lg font-semibold leading-5 tabular-nums',
                        showExpiryNotice ? 'text-destructive' : 'text-foreground'
                      )}
                    >
                      {daysRemaining}
                    </span>
                    {/* profile.dayShort — уже существующий короткий «д», ровно так
                        же его склеивает карточка профиля (profile-item.tsx:120).
                        Новый ключ под это не нужен. */}
                    <span
                      className={cn(
                        'text-xs',
                        showExpiryNotice ? 'text-destructive/75' : 'text-muted-foreground'
                      )}
                    >
                      {t('profile.dayShort')}
                    </span>
                  </span>
                ) : (
                  <InfinityIcon
                    aria-hidden
                    className={cn(
                      'size-[17px]',
                      showExpiryNotice ? 'text-destructive' : 'text-foreground'
                    )}
                  />
                )}
              </div>

              {/* Справа одна кнопка, а не две: когда подписка кончается, продлить
                  её — единственное осмысленное действие, и оно занимает место
                  обновления. Обновить в этот момент можно со страницы подписки,
                  куда ведёт сама строка. */}
              {showExpiryNotice && renewAction ? (
                <button
                  type="button"
                  onClick={() => open(renewAction.url)}
                  className="relative z-10 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-destructive/40 px-2 text-xs font-semibold text-destructive outline-none transition-colors hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)]"
                >
                  <CreditCard className="size-3.5 shrink-0" aria-hidden />
                  <span className="max-w-24 truncate">{renewAction.label}</span>
                </button>
              ) : (
                refreshButton
              )}

              {/* Полоса расхода только при лимите — см. комментарий к usedShare.
                  Лежит в нижних 6px, которые строка специально под неё выросла.
                  pointer-events-none: полоса спозиционирована поверх подложки и
                  без этого съедала бы клики по низу строки. */}
              {hasTrafficLimit && (
                <div className="pointer-events-none absolute inset-x-3 bottom-1.5 h-0.5 overflow-hidden rounded-full bg-muted-foreground/20">
                  <div
                    className={cn('h-full rounded-full transition-all', usedShareColor)}
                    style={{ width: `${Math.max(2, usedShare)}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* --- Список серверов ------------------------------------------ */}
          <ServerList />
        </div>
      )}

      {needsCorePermission && (
        <ConfirmModal
          title={t('pages.home.corePermissionTitle')}
          description={
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t('pages.home.corePermissionText')}</p>
              <p className="text-xs text-muted-foreground">{t('pages.home.corePermissionHint')}</p>
            </div>
          }
          confirmText={t('pages.home.corePermissionGrant')}
          cancelText={t('common.cancel')}
          onChange={(open) => {
            if (!open) setNeedsCorePermission(false)
          }}
          onConfirm={grantAndConnect}
        />
      )}
    </div>
  )
}

export default Home
