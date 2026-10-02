import React, { useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  Camera,
  Eraser,
  Github,
  Globe,
  KeyRound,
  LogOut,
  Map as MapIcon,
  MonitorCog,
  Network,
  Palette,
  Power,
  RefreshCw,
  Rocket,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import BasePage from '@renderer/components/base/base-page'
import ConfirmModal from '@renderer/components/base/base-confirm'
import UpdaterModal from '@renderer/components/updater/updater-modal'
import { Group, Row, SegmentRow, SelectRow, SwitchRow } from '@renderer/components/shell/list-group'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useLanguage } from '@renderer/hooks/use-language'
import { useUpdaterStore } from '@renderer/store/updater-store'
import { version } from '@renderer/utils/init'
import { startTour } from '@renderer/utils/driver'
import { hiddenSettingsUnlocked, unlockHiddenSettings } from '@renderer/utils/hidden-settings'
import {
  cancelUpdate,
  checkAutoRun,
  checkUpdate,
  createHeapSnapshot,
  disableAutoRun,
  enableAutoRun,
  mihomoHotReloadConfig,
  mihomoVersion,
  quitApp,
  quitWithoutCore,
  relaunchApp,
  resetAppConfig,
  triggerSysProxy,
  updateTrayIcon
} from '@renderer/utils/ipc'

// Семь нажатий по версии открывают служебные настройки. Приём от upstream,
// сохранён как есть: им пользуются при разборе обращений.
const EASTER_EGG_TAP_COUNT = 7

// Экран настроек, вариант «как в системных настройках» (решение владельца
// 02.10.2026). Три раздела, которые раньше были свёрнутыми аккордеонами и
// прятали 47 строк, стали отдельными страницами: ничего не спрятано, экран
// умещается целиком.
//
// ⚠️ Подсказок-вопросиков больше нет. Их было 22 штуки, и каждая прятала
// строчку текста за нажатием. Текст переехал во вторую строку самой настройки:
// читается сразу и не требует ни наведения, ни попадания в значок 24×24.
const Settings: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    silentStart = false,
    autoCheckUpdate = false,
    disableGPU = false,
    proxyMode = false,
    onlyActiveDevice = false,
    mainSwitchMode = 'tun',
    sysProxy,
    showTour = false
  } = appConfig || {}
  const { enable: writeSysProxy = true, mode } = sysProxy || {}

  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { tun, 'mixed-port': mixedPort } = controledMihomoConfig || {}
  // Системный прокси нечем занять, пока у ядра нет смешанного порта.
  const sysProxyDisabled = writeSysProxy && mode === 'manual' && mixedPort === 0

  const { data: autoRun, mutate: mutateAutoRun } = useSWR('checkAutoRun', checkAutoRun)
  const { data: coreVersion } = useSWR('mihomoVersion', mihomoVersion)
  const { currentLanguage, changeLanguage, languages } = useLanguage()

  const [showHidden, setShowHidden] = useState(hiddenSettingsUnlocked)
  const [checking, setChecking] = useState(false)
  const [newVersion, setNewVersion] = useState('')
  const [changelog, setChangelog] = useState('')
  const [openUpdate, setOpenUpdate] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [pendingDisableGPU, setPendingDisableGPU] = useState(disableGPU)
  const tapsRef = useRef(0)

  const updateStatus = useUpdaterStore(
    useShallow((s) => ({ downloading: s.downloading, progress: s.progress, error: s.error }))
  )
  const resetUpdateStatus = useUpdaterStore((s) => s.reset)

  const onVersionTap = (): void => {
    if (showHidden) return
    tapsRef.current = Math.min(tapsRef.current + 1, EASTER_EGG_TAP_COUNT)
    if (tapsRef.current >= EASTER_EGG_TAP_COUNT) {
      unlockHiddenSettings()
      setShowHidden(true)
    }
  }

  const onCheckUpdate = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    try {
      const found = await checkUpdate()
      if (found) {
        setNewVersion(found.version)
        setChangelog(found.changelog)
        setOpenUpdate(true)
      } else {
        toast.success(t('settings.actions.noNeedUpdate'))
      }
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      setChecking(false)
    }
  }

  const onToggleTun = async (enable: boolean): Promise<void> => {
    // DNS включается вместе с TUN: без него туннель поднимается, а имена не
    // разрешаются, и человек видит «интернета нет».
    await patchControledMihomoConfig(enable ? { tun: { enable }, dns: { enable: true } } : { tun: { enable } })
    window.electron.ipcRenderer.send('updateFloatingWindow')
    window.electron.ipcRenderer.send('updateTrayMenu')
    await updateTrayIcon()
  }

  const onToggleProxy = async (enable: boolean): Promise<void> => {
    if (enable && sysProxyDisabled) return
    try {
      if (enable) {
        await patchAppConfig({ proxyMode: true })
        await mihomoHotReloadConfig()
        if (writeSysProxy) await triggerSysProxy(true, onlyActiveDevice)
      } else {
        if (writeSysProxy) await triggerSysProxy(false, onlyActiveDevice)
        await patchAppConfig({ proxyMode: false })
        await mihomoHotReloadConfig()
      }
      window.electron.ipcRenderer.send('updateFloatingWindow')
      window.electron.ipcRenderer.send('updateTrayMenu')
      await updateTrayIcon()
    } catch (e) {
      toast.error(`${e}`)
    }
  }

  return (
    <BasePage
      title={t('pages.settings.title')}
      header={
        <button
          type="button"
          onClick={() => window.open('https://github.com/AiAsteroid/SlavaNET-client')}
          aria-label={t('pages.settings.githubRepo')}
          title={t('pages.settings.githubRepo')}
          className="app-nodrag flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Github className="size-4" />
        </button>
      }
    >
      {openUpdate && (
        <UpdaterModal
          onClose={() => setOpenUpdate(false)}
          version={newVersion}
          changelog={changelog}
          updateStatus={updateStatus}
          onCancel={async () => {
            try {
              await cancelUpdate()
              resetUpdateStatus()
            } catch {
              // Отмена загрузки — не то, о чём стоит сообщать человеку.
            }
          }}
        />
      )}
      {confirmReset && (
        <ConfirmModal
          onChange={setConfirmReset}
          title={t('settings.actions.confirmReset')}
          description={
            <>
              {t('settings.actions.resetWarning')}
              <span className="text-destructive">{t('settings.actions.cannotUndo')}</span>
            </>
          }
          confirmText={t('settings.actions.confirmDelete')}
          cancelText={t('common.cancel')}
          onConfirm={resetAppConfig}
        />
      )}
      {confirmRestart && (
        <ConfirmModal
          title={t('modal.confirmRestart')}
          description={<p>{t('modal.restartForGPUChange')}</p>}
          confirmText={t('common.restart')}
          cancelText={t('common.cancel')}
          onChange={(open) => {
            if (!open) setPendingDisableGPU(disableGPU)
            setConfirmRestart(open)
          }}
          onConfirm={async () => {
            await patchAppConfig({ disableGPU: pendingDisableGPU })
            await relaunchApp()
          }}
        />
      )}

      <div className="px-4 pt-1">
        <Group title={t('pages.settings.groupConnection')}>
          <SwitchRow
            icon={Network}
            label={t('sider.virtualInterface')}
            sub={t('pages.settings.tunHint')}
            checked={tun?.enable ?? false}
            onCheckedChange={onToggleTun}
            action={{
              icon: SettingsIcon,
              label: t('pages.settings.tunSettings'),
              onClick: () => navigate('/tun')
            }}
          />
          <SwitchRow
            icon={Globe}
            label={t('sider.proxyMode')}
            sub={t('pages.settings.proxyHint')}
            checked={proxyMode}
            disabled={sysProxyDisabled}
            onCheckedChange={onToggleProxy}
            action={{
              icon: SettingsIcon,
              label: t('pages.settings.proxySettings'),
              onClick: () => navigate('/sysproxy')
            }}
          />
          <SegmentRow
            label={t('settings.advanced.mainSwitch')}
            value={mainSwitchMode}
            options={[
              { value: 'tun', label: t('settings.advanced.mainSwitchTun') },
              { value: 'sysproxy', label: t('settings.advanced.mainSwitchProxyMode') }
            ]}
            onChange={(next) => patchAppConfig({ mainSwitchMode: next })}
          />
        </Group>

        <Group title={t('pages.settings.groupApp')}>
          <SwitchRow
            icon={Rocket}
            label={t('settings.general.autoStart')}
            checked={autoRun ?? false}
            onCheckedChange={async (value) => {
              try {
                if (value) await enableAutoRun()
                else await disableAutoRun()
              } catch (e) {
                toast.error(`${e}`)
              } finally {
                mutateAutoRun()
              }
            }}
          />
          <SwitchRow
            icon={Power}
            label={t('settings.general.silentStart')}
            checked={silentStart}
            onCheckedChange={(value) => patchAppConfig({ silentStart: value })}
          />
          <SwitchRow
            icon={RefreshCw}
            label={t('settings.general.autoCheckUpdate')}
            checked={autoCheckUpdate}
            onCheckedChange={(value) => patchAppConfig({ autoCheckUpdate: value })}
          />
          <SelectRow
            icon={Globe}
            label={t('settings.appearance.language')}
            value={currentLanguage}
            options={languages.map((l) => ({ value: l.value, label: l.nativeLabel }))}
            onChange={(next) => changeLanguage(next as 'zh-CN' | 'en-US' | 'ru-RU')}
          />
          {showHidden && (
            <SwitchRow
              icon={MonitorCog}
              label={t('settings.general.disableGPU')}
              sub={t('settings.general.disableGPUHelp')}
              checked={pendingDisableGPU}
              onCheckedChange={(value) => {
                setPendingDisableGPU(value)
                setConfirmRestart(true)
              }}
            />
          )}
        </Group>

        <Group title={t('pages.settings.groupSections')}>
          <Row
            icon={Palette}
            label={t('settings.appearance.title')}
            trailing="chevron"
            onClick={() => navigate('/settings/appearance')}
          />
          <Row
            icon={SlidersHorizontal}
            label={t('settings.advanced.title')}
            trailing="chevron"
            onClick={() => navigate('/settings/advanced')}
          />
          <Row
            icon={KeyRound}
            label={t('settings.shortcuts.title')}
            trailing="chevron"
            onClick={() => navigate('/settings/shortcuts')}
          />
        </Group>

        <Group title={t('pages.settings.groupMaintenance')}>
          <Row
            icon={RefreshCw}
            label={t('settings.actions.checkUpdate')}
            busy={checking}
            trailing="chevron"
            onClick={onCheckUpdate}
          />
          {showTour && (
            <Row
              icon={MapIcon}
              label={t('settings.actions.openGuidePage')}
              trailing="chevron"
              onClick={() => {
                window.localStorage.setItem('tourShown', 'true')
                startTour(navigate)
              }}
            />
          )}
          {showHidden && (
            <Row
              icon={Eraser}
              label={t('settings.actions.clearCache')}
              sub={t('settings.actions.clearCacheHelp')}
              trailing="chevron"
              onClick={() => localStorage.clear()}
            />
          )}
          {showHidden && (
            <Row
              icon={Camera}
              label={t('settings.actions.createHeapSnapshot')}
              sub={t('settings.actions.createHeapSnapshotHelp')}
              trailing="chevron"
              onClick={createHeapSnapshot}
            />
          )}
          <Row
            icon={LogOut}
            label={t('settings.actions.quitKeepCore')}
            sub={t('settings.actions.quitKeepCoreHelp')}
            trailing="chevron"
            onClick={quitWithoutCore}
          />
          <Row
            icon={LogOut}
            label={t('settings.actions.quitApp')}
            trailing="chevron"
            onClick={quitApp}
          />
          {/* Необратимое — последним и красным: по весу и по месту видно, что
              это не соседняя по смыслу кнопка, а край. */}
          <Row
            icon={Trash2}
            label={t('settings.actions.resetApp')}
            sub={t('settings.actions.resetAppHelp')}
            danger
            trailing="chevron"
            onClick={() => setConfirmReset(true)}
          />
        </Group>

        <Group title={t('pages.settings.groupAbout')}>
          <Row label={t('settings.actions.appVersion')} value={`v${version}`} onClick={onVersionTap} />
          <Row
            label={t('settings.actions.mihomoVersion')}
            value={coreVersion?.version ?? '…'}
            trailing="chevron"
            onClick={() => navigate('/mihomo')}
          />
        </Group>
      </div>
    </BasePage>
  )
}

export default Settings
