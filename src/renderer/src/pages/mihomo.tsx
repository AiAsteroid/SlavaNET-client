import React, { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import PubSub from 'pubsub-js'
import {
  Clock,
  CloudDownload,
  Cpu,
  FileText,
  FolderOpen,
  Globe,
  KeyRound,
  MonitorCog,
  Shield
} from 'lucide-react'
import BasePage from '@renderer/components/base/base-page'
import ConfirmModal, { ConfirmButton } from '@renderer/components/base/base-confirm'
import {
  FieldRow,
  Group,
  Row,
  SegmentRow,
  SelectRow,
  SwitchRow
} from '@renderer/components/shell/list-group'
import PermissionModal from '@renderer/components/mihomo/permission-modal'
import ServiceModal from '@renderer/components/mihomo/service-modal'
import PortSetting from '@renderer/components/mihomo/port-setting'
import ControllerSetting from '@renderer/components/mihomo/controller-setting'
import EnvSetting from '@renderer/components/mihomo/env-setting'
import AdvancedSetting from '@renderer/components/mihomo/advanced-settings'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { platform } from '@renderer/utils/init'
import {
  manualGrantCorePermition,
  mihomoUpgrade,
  restartCore,
  revokeCorePermission,
  findSystemMihomo,
  deleteElevateTask,
  checkElevateTask,
  relaunchApp,
  restartAsAdmin,
  notDialogQuit,
  installService,
  uninstallService,
  startService,
  stopService,
  initService,
  restartService
} from '@renderer/utils/ipc'

let systemCorePathsCache: string[] | null = null
let cachePromise: Promise<string[]> | null = null

const getSystemCorePaths = async (): Promise<string[]> => {
  if (systemCorePathsCache !== null) return systemCorePathsCache
  if (cachePromise !== null) return cachePromise

  cachePromise = findSystemMihomo()
    .then((paths) => {
      systemCorePathsCache = paths
      cachePromise = null
      return paths
    })
    .catch(() => {
      cachePromise = null
      return []
    })

  return cachePromise
}

getSystemCorePaths().catch(() => {})

// Настройки ядра на общем наборе строк (shell/list-group) — самый большой набор
// в приложении: сорок настроек на пяти файлах.
//
// Было: пять карточек старого вида подряд. Только на этой странице — девять
// строк, в которых значок-действие ютился в углу («обновить ядро»), а кнопка
// «Управление» ничем не отличалась от соседнего селекта. Стало: четыре группы
// со строками того же вида, что на остальных экранах, а порты, контроллер,
// переменные окружения и расширенные настройки приносят свои группы сами.
//
// ⚠️ Обёртку с отступами (px-4 pt-1) ставит страница, а не компоненты внутри:
// иначе у пяти наборов групп разъехались бы боковые поля.
//
// ⚠️ Заголовки групп взяты из СУЩЕСТВУЮЩИХ ключей перевода: локали правит
// другой человек, новых ключей здесь не появляется. Первые две группы остались
// без заголовка — подходящего ключа на «Ядро» и «Права» в локалях нет, а
// заводить новый нельзя.
const Mihomo: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { core = 'mihomo', maxLogDays = 7, corePermissionMode = 'elevated' } = appConfig || {}
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { ipv6, 'log-level': logLevel = 'info' } = controledMihomoConfig || {}

  const [upgrading, setUpgrading] = useState(false)
  const [showGrantConfirm, setShowGrantConfirm] = useState(false)
  const [showUnGrantConfirm, setShowUnGrantConfirm] = useState(false)
  const [showPermissionModal, setShowPermissionModal] = useState(false)
  const [showServiceModal, setShowServiceModal] = useState(false)
  const [pendingPermissionMode, setPendingPermissionMode] = useState<string>('')
  const [systemCorePaths, setSystemCorePaths] = useState<string[]>(systemCorePathsCache || [])
  const [loadingPaths, setLoadingPaths] = useState(systemCorePathsCache === null)

  useEffect(() => {
    if (systemCorePathsCache !== null) return

    getSystemCorePaths()
      .then(setSystemCorePaths)
      .catch(() => {})
      .finally(() => setLoadingPaths(false))
  }, [])

  const onChangeNeedRestart = async (patch: Partial<MihomoConfig>): Promise<void> => {
    await patchControledMihomoConfig(patch)
  }

  const handleConfigChangeWithRestart = async (key: string, value: unknown): Promise<void> => {
    try {
      await patchAppConfig({ [key]: value })
      await restartCore()
      PubSub.publish('mihomo-core-changed')
    } catch (e) {
      toast.error(`${e}`)
    }
  }

  const handleCoreUpgrade = async (): Promise<void> => {
    try {
      setUpgrading(true)
      await mihomoUpgrade()
      setTimeout(() => PubSub.publish('mihomo-core-changed'), 2000)
    } catch (e) {
      if (typeof e === 'string' && e.includes('already using latest version')) {
        new Notification(t('pages.mihomo.alreadyLatest'))
      } else {
        toast.error(`${e}`)
      }
    } finally {
      setUpgrading(false)
    }
  }

  const handleCoreChange = async (newCore: 'mihomo' | 'mihomo-alpha' | 'system'): Promise<void> => {
    if (newCore === 'system') {
      const paths = await getSystemCorePaths()

      if (paths.length === 0) {
        new Notification(t('pages.mihomo.systemCoreNotFound'), {
          body: t('pages.mihomo.systemCoreNotFoundBody')
        })
        return
      }

      if (!appConfig?.systemCorePath || !paths.includes(appConfig.systemCorePath)) {
        await patchAppConfig({ systemCorePath: paths[0] })
      }
    }
    handleConfigChangeWithRestart('core', newCore)
  }

  const handlePermissionModeChange = async (key: string): Promise<void> => {
    if (platform === 'win32') {
      if (key !== 'elevated') {
        if (await checkElevateTask()) {
          setPendingPermissionMode(key)
          setShowUnGrantConfirm(true)
        } else {
          patchAppConfig({ corePermissionMode: key as 'elevated' | 'service' })
        }
      } else if (key === 'elevated') {
        setPendingPermissionMode(key)
        setShowGrantConfirm(true)
      }
    } else {
      patchAppConfig({ corePermissionMode: key as 'elevated' | 'service' })
    }
  }

  const extraUnGrantButtons: ConfirmButton[] =
    platform === 'win32'
      ? [
          {
            key: 'cancel-and-restart',
            text: t('pages.mihomo.cancelAndRestart'),
            variant: 'destructive',
            onPress: async () => {
              try {
                await deleteElevateTask()
                new Notification(t('pages.mihomo.taskScheduleCanceled'))
                await patchAppConfig({
                  corePermissionMode: pendingPermissionMode as 'elevated' | 'service'
                })
                await relaunchApp()
              } catch (e) {
                toast.error(`${e}`)
              }
            }
          }
        ]
      : []

  const unGrantButtons: ConfirmButton[] = [
    {
      key: 'cancel',
      text: t('common.cancel'),
      variant: 'ghost',
      onPress: () => {}
    },
    {
      key: 'confirm',
      text:
        platform === 'win32'
          ? t('pages.mihomo.noRestartCancel')
          : t('pages.mihomo.confirmRevoke'),
      variant: 'destructive',
      onPress: async () => {
        try {
          if (platform === 'win32') {
            await deleteElevateTask()
            new Notification(t('pages.mihomo.taskScheduleCanceled'))
          } else {
            await revokeCorePermission()
            new Notification(t('pages.mihomo.corePermissionRevoked'))
          }
          await patchAppConfig({
            corePermissionMode: pendingPermissionMode as 'elevated' | 'service'
          })

          await restartCore()
        } catch (e) {
          toast.error(`${e}`)
        }
      }
    },
    ...extraUnGrantButtons
  ]

  const logLevelOptions: { value: LogLevel; label: string }[] = [
    { value: 'silent', label: t('pages.mihomo.silent') },
    { value: 'error', label: t('pages.mihomo.error') },
    { value: 'warning', label: t('pages.mihomo.warning') },
    { value: 'info', label: t('pages.mihomo.info') },
    { value: 'debug', label: t('pages.mihomo.debug') }
  ]

  const coreOptions: { value: 'mihomo' | 'mihomo-alpha' | 'system'; label: string }[] = [
    { value: 'mihomo', label: t('pages.mihomo.builtinStable') },
    { value: 'mihomo-alpha', label: t('pages.mihomo.builtinPreview') },
    { value: 'system', label: t('pages.mihomo.useSystemCore') }
  ]

  return (
    <BasePage title={t('pages.mihomo.title')}>
      {showGrantConfirm && (
        <ConfirmModal
          onChange={setShowGrantConfirm}
          title={t('pages.mihomo.confirmUseTaskSchedule')}
          description={t('pages.mihomo.confirmUseTaskScheduleDesc')}
          onConfirm={async () => {
            await patchAppConfig({
              corePermissionMode: pendingPermissionMode as 'elevated' | 'service',
              // Asking for the task schedule again overrides an earlier refusal to elevate
              elevationDeclined: false
            })
            await notDialogQuit()
          }}
        />
      )}
      {showUnGrantConfirm && (
        <ConfirmModal
          onChange={setShowUnGrantConfirm}
          title={t('pages.mihomo.confirmCancelTaskSchedule')}
          description={t('pages.mihomo.confirmCancelTaskScheduleDesc')}
          buttons={unGrantButtons}
        />
      )}
      {showPermissionModal && (
        <PermissionModal
          onChange={setShowPermissionModal}
          onRevoke={async () => {
            if (platform === 'win32') {
              await deleteElevateTask()
              new Notification(t('pages.mihomo.taskScheduleCanceled'))
            } else {
              await revokeCorePermission()
              new Notification(t('pages.mihomo.corePermissionRevoked'))
            }
            await restartCore()
          }}
          onGrant={async () => {
            if (platform === 'win32') {
              await restartAsAdmin()
              return
            }
            await manualGrantCorePermition()
            new Notification(t('pages.mihomo.coreAuthSuccess'))
            await restartCore()
          }}
        />
      )}
      {showServiceModal && (
        <ServiceModal
          onChange={setShowServiceModal}
          onInit={async () => {
            await initService()
            new Notification(t('pages.mihomo.serviceInitSuccess'))
          }}
          onInstall={async () => {
            await installService()
            new Notification(t('pages.mihomo.serviceInstallSuccess'))
          }}
          onUninstall={async () => {
            await uninstallService()
            new Notification(t('pages.mihomo.serviceUninstallSuccess'))
          }}
          onStart={async () => {
            await startService()
            new Notification(t('pages.mihomo.serviceStartSuccess'))
          }}
          onRestart={async () => {
            await restartService()
            new Notification(t('pages.mihomo.serviceRestartSuccess'))
          }}
          onStop={async () => {
            await stopService()
            new Notification(t('pages.mihomo.serviceStopSuccess'))
          }}
        />
      )}

      <div className="px-4 pt-1">
        <Group>
          <SelectRow
            icon={Cpu}
            label={t('pages.mihomo.coreVersion')}
            value={core}
            options={coreOptions}
            onChange={handleCoreChange}
          />
          {/* Путь к системному ядру. Три состояния вместо одного селекта с
              подменённым текстом-заглушкой: пока ищем — строка со спиннером,
              не нашли — строка с предупреждением во второй строке, нашли —
              обычный выбор. Ключи перевода те же, что были у заглушки. */}
          {core === 'system' &&
            (loadingPaths ? (
              <Row
                icon={FolderOpen}
                label={t('pages.mihomo.systemCorePath')}
                value={t('pages.mihomo.searchingCore')}
                busy
              />
            ) : systemCorePaths.length === 0 ? (
              <Row
                icon={FolderOpen}
                label={t('pages.mihomo.systemCorePath')}
                sub={t('pages.mihomo.coreNotFoundWarning')}
                value={t('pages.mihomo.coreNotFound')}
              />
            ) : (
              <SelectRow
                icon={FolderOpen}
                label={t('pages.mihomo.systemCorePath')}
                value={appConfig?.systemCorePath ?? ''}
                options={systemCorePaths.map((path) => ({ value: path, label: path }))}
                onChange={(value) => {
                  if (value) handleConfigChangeWithRestart('systemCorePath', value)
                }}
              />
            ))}
          {/* Обновление ядра раньше было значком 24×24 в углу строки с версией:
              что он делает, можно было узнать только наведением. Системному
              ядру обновляться нечем — мы его не ставили. */}
          {(core === 'mihomo' || core === 'mihomo-alpha') && (
            <Row
              icon={CloudDownload}
              label={t('pages.mihomo.upgradeCore')}
              busy={upgrading}
              disabled={upgrading}
              trailing="chevron"
              onClick={handleCoreUpgrade}
            />
          )}
        </Group>

        <Group>
          {/* ⚠️ «Системная служба» в upstream выключена (у вкладки стоял
              disabled): она не доделана, см. mihomo.serviceModal.description4.
              У сегментов нет отключения ОТДЕЛЬНОГО значения, поэтому запрет
              переехал в обработчик — нажатие по ней по-прежнему ничего не
              делает. Убирать значение нельзя: о режиме надо знать, что он
              есть. */}
          <SegmentRow
            icon={Shield}
            label={t('pages.mihomo.runningMode')}
            value={corePermissionMode}
            options={[
              {
                value: 'elevated',
                label:
                  platform === 'win32'
                    ? t('pages.mihomo.taskSchedule')
                    : t('pages.mihomo.authorizedRun')
              },
              { value: 'service', label: t('pages.mihomo.systemService') }
            ]}
            onChange={(value) => {
              if (value === 'service') return
              void handlePermissionModeChange(value)
            }}
          />
          <Row
            icon={KeyRound}
            label={
              platform === 'win32' ? t('pages.mihomo.taskStatus') : t('pages.mihomo.authStatus')
            }
            trailing="chevron"
            onClick={() => setShowPermissionModal(true)}
          />
          <Row
            icon={MonitorCog}
            label={t('pages.mihomo.serviceStatus')}
            trailing="chevron"
            onClick={() => setShowServiceModal(true)}
          />
        </Group>

        <Group title={t('pages.settings.groupConnection')}>
          <SwitchRow
            icon={Globe}
            label="IPv6"
            checked={ipv6 ?? false}
            onCheckedChange={(v) => onChangeNeedRestart({ ipv6: v })}
          />
        </Group>

        <Group title={t('pages.more.diagnostics.logs')}>
          <FieldRow
            icon={Clock}
            label={t('pages.mihomo.logRetentionDays')}
            value={maxLogDays.toString()}
            width={72}
            inputMode="numeric"
            onCommit={async (next) => {
              // ⚠️ Раньше поле писало результат parseInt как есть, и пустое
              // поле уносило в конфиг NaN. Ноль оставлен: он был достижим и
              // раньше и значит «логи не хранить».
              let num = parseInt(next)
              if (isNaN(num) || num < 0) num = 0
              await patchAppConfig({ maxLogDays: num })
            }}
          />
          {/* Хитрость с невидимыми копиями вариантов больше не нужна: ширину
              строке задаёт сам набор, а значение стоит справа и обрезается им
              же. */}
          <SelectRow
            icon={FileText}
            label={t('pages.mihomo.logLevel')}
            value={logLevel}
            options={logLevelOptions}
            onChange={(value) => onChangeNeedRestart({ 'log-level': value })}
          />
        </Group>

        <PortSetting />
        <ControllerSetting />
        <EnvSetting />
        <AdvancedSetting />
      </div>
    </BasePage>
  )
}

export default Mihomo
