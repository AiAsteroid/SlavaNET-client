import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import React, { useEffect, useRef, useState } from 'react'
import { NavigateFunction, useNavigate, useRoutes } from 'react-router-dom'
import './i18n'
import { useTranslation } from 'react-i18next'
import routes from '@renderer/routes'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  applyTheme,
  checkUpdate,
  declineElevation,
  needsFirstRunAdmin,
  restartAsAdmin,
  setNativeTheme
} from '@renderer/utils/ipc'
import { platform } from '@renderer/utils/init'
import useSWR from 'swr'
import ConfirmModal from '@renderer/components/base/base-confirm'
import UpdateBanner from '@renderer/components/updater/update-banner'
import HwidLimitAlert from '@renderer/components/profiles/hwid-limit-alert'
import BottomNav from '@renderer/components/shell/bottom-nav'
import { attachConnectionsStore } from '@renderer/store/connections-store'
import { attachTrafficStore } from '@renderer/store/traffic-store'
import { attachLogsStore } from '@renderer/store/logs-store'
import { attachUpdaterStore } from '@renderer/store/updater-store'
import { attachCoreLifecycleStore } from '@renderer/store/core-lifecycle-store'
import { attachLoginStore, useLoginStore } from '@renderer/store/login-store'
import CabinetLoginModal from '@renderer/components/profiles/cabinet-login-modal'

let navigate: NavigateFunction

const isMac = platform === 'darwin'

const App: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig } = useAppConfig()
  const {
    appTheme = 'system',
    customTheme,
    autoCheckUpdate,
    // Onboarding tour is off by default: the empty home screen with a single
    // "Add subscription" button is the intended first run. The tour itself is
    // kept intact and comes back by flipping this flag.
    showTour = false
  } = appConfig || {}
  const { setTheme, systemTheme } = useTheme()
  navigate = useNavigate()
  const page = useRoutes(routes)
  const { data: latest } = useSWR(
    autoCheckUpdate ? ['checkUpdate'] : undefined,
    autoCheckUpdate ? checkUpdate : (): undefined => {},
    {
      refreshInterval: 1000 * 60 * 10
    }
  )

  useEffect(() => {
    const detachConnections = attachConnectionsStore()
    const detachTraffic = attachTrafficStore()
    const detachLogs = attachLogsStore()
    const detachUpdater = attachUpdaterStore()
    const detachCoreLifecycle = attachCoreLifecycleStore()
    const detachLogin = attachLoginStore()
    return (): void => {
      detachConnections()
      detachTraffic()
      detachLogs()
      detachUpdater()
      detachCoreLifecycle()
      detachLogin()
    }
  }, [])

  // Фон окна отдан нативному материалу (vibrancy), и документ обязан быть
  // прозрачным — иначе материала не видно и стекло пропадает. Класс ставится
  // только на macOS: на Windows и Linux материала нет, и прозрачный документ
  // дал бы чёрное окно.
  useEffect(() => {
    if (!isMac) return
    document.documentElement.classList.add('window-material')
  }, [])

  // Полный экран: светофора там нет, и держать под него полосу в 52 px значит
  // оставить сверху пустоту. Событие приходит и при каждой загрузке рендерера,
  // поэтому начальное состояние отдельным запросом брать не нужно.
  useEffect(() => {
    const onFullScreen = (_e: unknown, isFullScreen: boolean): void => {
      document.documentElement.toggleAttribute('data-fullscreen', isFullScreen)
    }
    window.electron.ipcRenderer.on('window-fullscreen', onFullScreen)
    return (): void => {
      window.electron.ipcRenderer.removeAllListeners('window-fullscreen')
    }
  }, [])

  // ⌘, — стандартное место настроек на macOS. Главный процесс к этому моменту
  // уже показал окно, нам остаётся только перейти.
  useEffect(() => {
    const onOpenSettings = (): void => {
      navigate('/settings')
    }
    window.electron.ipcRenderer.on('open-settings', onOpenSettings)
    return (): void => {
      window.electron.ipcRenderer.removeAllListeners('open-settings')
    }
  }, [])

  useEffect(() => {
    if (!showTour) return
    const tourShown = window.localStorage.getItem('tourShown')
    if (!tourShown) {
      import('@renderer/utils/driver').then(({ startTour }) => {
        startTour(navigate, {
          onMainGuideCompleted: (): void => {
            window.localStorage.setItem('tourShown', 'true')
          }
        })
      })
    }
  }, [showTour])

  useEffect(() => {
    setNativeTheme(appTheme)
    setTheme(appTheme)
  }, [appTheme, systemTheme])

  useEffect(() => {
    applyTheme(customTheme || 'default.css')
  }, [customTheme])

  // Lives at the top so a slavanet://connect link from the website can open it
  // no matter which screen the person happens to be on.
  const loginOpen = useLoginStore((s) => s.open)
  const setLoginOpen = useLoginStore((s) => s.setOpen)

  const [showQuitConfirm, setShowQuitConfirm] = useState(false)
  const [showProfileInstallConfirm, setShowProfileInstallConfirm] = useState(false)
  const [showAdminRequired, setShowAdminRequired] = useState(false)
  const adminRestartRequestedRef = useRef(false)
  const profileInstallConfirmedRef = useRef(false)
  const [profileInstallData, setProfileInstallData] = useState<{
    url: string
    name?: string | null
  }>()

  useEffect(() => {
    const handleShowQuitConfirm = (): void => {
      setShowQuitConfirm(true)
    }
    const handleShowProfileInstallConfirm = (
      _event: unknown,
      data: { url: string; name?: string | null }
    ): void => {
      profileInstallConfirmedRef.current = false
      setProfileInstallData(data)
      setShowProfileInstallConfirm(true)
    }

    window.electron.ipcRenderer.on('show-quit-confirm', handleShowQuitConfirm)
    window.electron.ipcRenderer.on('show-profile-install-confirm', handleShowProfileInstallConfirm)

    const handleShowError = (_event: unknown, title: string, message: string): void => {
      toast.error(title, { description: message })
    }
    window.electron.ipcRenderer.on('showError', handleShowError)

    const handleNeedsAdminSetup = (): void => {
      setShowAdminRequired(true)
    }
    window.electron.ipcRenderer.on('needs-admin-setup', handleNeedsAdminSetup)

    if (platform === 'win32') {
      needsFirstRunAdmin().then((needs) => {
        if (needs) setShowAdminRequired(true)
      })
    }

    return (): void => {
      window.electron.ipcRenderer.removeAllListeners('show-quit-confirm')
      window.electron.ipcRenderer.removeAllListeners('show-profile-install-confirm')
      window.electron.ipcRenderer.removeAllListeners('needs-admin-setup')
      window.electron.ipcRenderer.removeAllListeners('showError')
    }
  }, [])

  const handleQuitConfirm = (confirmed: boolean): void => {
    setShowQuitConfirm(false)
    window.electron.ipcRenderer.send('quit-confirm-result', confirmed)
  }

  const handleProfileInstallConfirm = (confirmed: boolean): void => {
    setShowProfileInstallConfirm(false)
    window.electron.ipcRenderer.send('profile-install-confirm-result', confirmed)
  }

  return (
    <div className="relative w-full h-screen flex flex-col overflow-hidden">
      {showQuitConfirm && (
        <ConfirmModal
          title={t('modal.confirmQuit')}
          description={
            <div>
              <p></p>
              <p className="text-sm text-muted-foreground mt-2">{t('modal.quitWarning')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('modal.quickQuitHint')} {isMac ? '⌘Q' : 'Ctrl+Q'} {t('modal.canQuitDirectly')}
              </p>
            </div>
          }
          confirmText={t('common.quit')}
          cancelText={t('common.cancel')}
          onChange={(open) => {
            if (!open) {
              handleQuitConfirm(false)
            }
          }}
          onConfirm={() => handleQuitConfirm(true)}
        />
      )}
      {showProfileInstallConfirm && profileInstallData && (
        <ConfirmModal
          title={t('modal.confirmImportProfile')}
          description={
            <div className="max-w-md">
              <p className="text-sm text-muted-foreground mb-2">
                {t('modal.nameLabel')}
                {profileInstallData.name || t('common.unnamed')}
              </p>
              <p className="text-sm text-muted-foreground mb-2 truncate">
                {t('modal.linkLabel')}
                {profileInstallData.url}
              </p>
              <p className="text-sm text-orange-500 mt-2 text-balance">
                {t('modal.ensureTrustedSource')}
              </p>
            </div>
          }
          confirmText={t('common.import')}
          cancelText={t('common.cancel')}
          onChange={(open) => {
            if (!open) {
              handleProfileInstallConfirm(profileInstallConfirmedRef.current)
              profileInstallConfirmedRef.current = false
            }
          }}
          onConfirm={() => {
            profileInstallConfirmedRef.current = true
          }}
          className="min-w-lg guide-profile-install-modal"
        />
      )}
      {showAdminRequired && (
        <ConfirmModal
          title={t('modal.adminRequired')}
          description={
            <div>
              <p className="text-sm">{t('modal.adminRequiredDesc')}</p>
            </div>
          }
          confirmText={t('modal.restartAsAdmin')}
          cancelText={t('modal.continueWithoutAdmin')}
          onChange={(open) => {
            if (!open) {
              setShowAdminRequired(false)
              // Dismissing the dialog means the user declines: remember it so the app stops
              // asking on every launch and falls back to system proxy only.
              if (!adminRestartRequestedRef.current) {
                declineElevation().catch(() => {})
              }
              adminRestartRequestedRef.current = false
            }
          }}
          onConfirm={async () => {
            adminRestartRequestedRef.current = true
            await restartAsAdmin()
          }}
          className="guide-admin-required-modal"
        />
      )}
      {loginOpen && <CabinetLoginModal onClose={() => setLoginOpen(false)} />}
      <HwidLimitAlert />
      {latest?.version && <UpdateBanner latest={latest} />}

      {/* Страница сама рисует свою верхнюю полосу и сама прокручивает своё
          содержимое. Внешней прокрутки тут быть не должно: иначе при низком
          окне список серверов сожмётся вместо того, чтобы прокручиваться. */}
      <div className="main relative flex-1 min-h-0 overflow-hidden">{page}</div>

      {/* Капсула одна на документ: второй экземпляр сломал бы переезд
          активного овала — он держится на общем layoutId. */}
      <BottomNav />
    </div>
  )
}

export default App
