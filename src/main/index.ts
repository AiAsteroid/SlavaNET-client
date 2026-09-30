import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { registerIpcMainHandlers } from './utils/ipc'
import windowStateKeeper from 'electron-window-state'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  shell
} from 'electron'
import {
  addProfileItem,
  getAppConfig,
  getProfileConfig,
  patchControledMihomoConfig,
  removeProfileItem
} from './config'
import { quitWithoutCore, startCore, stopCore } from './core/manager'
import { triggerSysProxy } from './sys/sysproxy'
import icon from '../../resources/icon.png?asset'
import { createTray } from './resolve/tray'
import { createApplicationMenu } from './resolve/menu'
import { init } from './utils/init'
import path, { join } from 'path'
import { initShortcut } from './resolve/shortcut'
import { execSync, spawn } from 'child_process'
import { createElevateTaskSync } from './sys/misc'
import { initProfileUpdater } from './core/profileUpdater'
import { existsSync, writeFileSync } from 'fs'
import { exePath, taskDir } from './utils/dirs'
import { showFloatingWindow } from './resolve/floatingWindow'
import { safeSend } from './utils/safeSend'
import {
  getPendingSubscriptionConnect,
  hasCabinetSession,
  runEmailLogin,
  runSubscriptionConnect,
  runSubscriptionFromSession,
  signOutOfCabinet
} from './resolve/connect'
import { getAppConfigSync } from './config/app'
import { declineElevation, ELEVATION_DECLINED_ARG } from './utils/elevation'
import { t } from './utils/i18n'


let quitTimeout: NodeJS.Timeout | null = null
export let mainWindow: BrowserWindow | null = null
export let needsFirstRunAdmin = false

export function setNeedsFirstRunAdmin(value: boolean): void {
  needsFirstRunAdmin = value
}

/**
 * Show error to the user via renderer toast notification.
 * Falls back to system dialog if the window is not available.
 */
export function showError(title: string, message: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('showError', title, message)
  } else {
    dialog.showErrorBox(title, message)
  }
}
let pendingDeepLink: string | null = null
let isCreatingWindow = false
let windowShown = false
let createWindowPromiseResolve: (() => void) | null = null
let createWindowPromise: Promise<void> | null = null

async function scheduleLightweightMode(): Promise<void> {
  const {
    autoLightweight = false,
    autoLightweightDelay = 60,
    autoLightweightMode = 'core'
  } = await getAppConfig()

  if (!autoLightweight) return

  if (quitTimeout) {
    clearTimeout(quitTimeout)
  }

  const enterLightweightMode = async (): Promise<void> => {
    if (autoLightweightMode === 'core') {
      await quitWithoutCore()
    } else if (autoLightweightMode === 'tray') {
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.destroy()
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
      }
    }
  }

  quitTimeout = setTimeout(enterLightweightMode, autoLightweightDelay * 1000)
}

const syncConfig = getAppConfigSync()

// Set when the previous instance relaunched us after the user dismissed the UAC prompt:
// the refusal is not in the config yet, so honour it from the command line for this run.
const elevationDeclinedByArg = process.argv.includes(ELEVATION_DECLINED_ARG)

if (
  process.platform === 'win32' &&
  !is.dev &&
  !process.argv.includes('noadmin') &&
  !elevationDeclinedByArg &&
  !syncConfig.elevationDeclined &&
  syncConfig.corePermissionMode !== 'service'
) {
  try {
    createElevateTaskSync()
  } catch (createError) {
    try {
      if (process.argv.slice(1).length > 0) {
        writeFileSync(path.join(taskDir(), 'param.txt'), process.argv.slice(1).join(' '))
      } else {
        writeFileSync(path.join(taskDir(), 'param.txt'), 'empty')
      }
      if (!existsSync(path.join(taskDir(), 'koala-clash-run.exe'))) {
        throw new Error('koala-clash-run.exe not found')
      } else {
        execSync('%SystemRoot%\\System32\\schtasks.exe /run /tn koala-clash-run')
      }
      app.exit()
    } catch {
      // First launch without admin — continue startup and show UI notification
      needsFirstRunAdmin = true
    }
  }
}

if (process.platform === 'win32' && is.dev) {
  patchControledMihomoConfig({ tun: { enable: false } })
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
}

export function customRelaunch(): void {
  const script = `while kill -0 ${process.pid} 2>/dev/null; do
  sleep 0.1
done
${process.argv.join(' ')} & disown
exit
`
  spawn('sh', ['-c', `"${script}"`], {
    shell: true,
    detached: true,
    stdio: 'ignore'
  })
}

if (process.platform === 'linux') {
  app.relaunch = customRelaunch
}

if (process.platform === 'win32' && !exePath().startsWith('C')) {
  // https://github.com/electron/electron/issues/43278
  // https://github.com/electron/electron/issues/36698
  app.commandLine.appendSwitch('in-process-gpu')
}

const initPromise = init()

if (syncConfig.disableGPU) {
  app.disableHardwareAcceleration()
}

// Kept next to handleDeepLink so a new scheme only has to be added once.
const DEEPLINK_PREFIXES = ['slavanet://']

function isDeepLink(arg: string): boolean {
  return DEEPLINK_PREFIXES.some((prefix) => arg.startsWith(prefix))
}

function getDeepLinkFromArgs(argv: string[]): string | undefined {
  return argv.find(isDeepLink)
}

app.on('second-instance', async (_event, commandline) => {
  showMainWindow()
  const url = getDeepLinkFromArgs(commandline)
  if (url) {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
      await handleDeepLink(url)
    } else {
      pendingDeepLink = url
    }
  }
})

app.on('open-url', async (_event, url) => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    await showMainWindow()
    await handleDeepLink(url)
  } else {
    pendingDeepLink = url
  }
})

let isQuitting = false,
  notQuitDialog = false

let lastQuitAttempt = 0

export function setNotQuitDialog(): void {
  notQuitDialog = true
}

function showWindow(): number {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    } else if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    mainWindow.focusOnWebView()
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu')
    mainWindow.focus()
    mainWindow.setAlwaysOnTop(false)

    if (!mainWindow.isMinimized()) {
      return 100
    }
  }
  return 500
}

function showQuitConfirmDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!mainWindow) {
      resolve(true)
      return
    }

    const delay = showWindow()
    setTimeout(() => {
      mainWindow?.webContents.send('show-quit-confirm')
      const handleQuitConfirm = (_event: Electron.IpcMainEvent, confirmed: boolean): void => {
        ipcMain.off('quit-confirm-result', handleQuitConfirm)
        resolve(confirmed)
      }
      ipcMain.once('quit-confirm-result', handleQuitConfirm)
    }, delay)
  })
}

app.on('window-all-closed', () => {
  // Don't quit app when all windows are closed
})

app.on('before-quit', async (e) => {
  if (!isQuitting && !notQuitDialog) {
    e.preventDefault()

    const now = Date.now()
    if (now - lastQuitAttempt < 500) {
      isQuitting = true
      if (quitTimeout) {
        clearTimeout(quitTimeout)
        quitTimeout = null
      }
      triggerSysProxy(false, false)
      await stopCore()
      app.exit()
      return
    }
    lastQuitAttempt = now

    const confirmed = await showQuitConfirmDialog()

    if (confirmed) {
      isQuitting = true
      if (quitTimeout) {
        clearTimeout(quitTimeout)
        quitTimeout = null
      }
      triggerSysProxy(false, false)
      await stopCore()
      app.exit()
    }
  } else if (notQuitDialog) {
    isQuitting = true
    if (quitTimeout) {
      clearTimeout(quitTimeout)
      quitTimeout = null
    }
    triggerSysProxy(false, false)
    await stopCore()
    app.exit()
  }
})

powerMonitor.on('shutdown', async () => {
  if (quitTimeout) {
    clearTimeout(quitTimeout)
    quitTimeout = null
  }
  triggerSysProxy(false, false)
  await stopCore()
  app.exit()
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('org.slavanet.client')
  try {
    await initPromise
  } catch (e) {
    dialog.showErrorBox(t('dialog.appInitFailed'), `${e}`)
    app.quit()
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  const appConfig = await getAppConfig()
  if (elevationDeclinedByArg && !appConfig.elevationDeclined) {
    await declineElevation()
  }
  const { showFloatingWindow: showFloating = false, disableTray = false } = appConfig
  registerIpcMainHandlers()

  // Check process.argv for deep link URL (cold start on Windows/Linux)
  if (!pendingDeepLink) {
    const deepLinkArg = getDeepLinkFromArgs(process.argv)
    if (deepLinkArg) {
      pendingDeepLink = deepLinkArg
    }
  }

  if (process.platform === 'win32') {
    try {
      writeFileSync(path.join(taskDir(), 'param.txt'), 'empty')
    } catch {
      // ignore
    }
  }

  const createWindowPromise = createWindow(appConfig)

  let coreStarted = false

  const coreStartPromise = (async (): Promise<void> => {
    try {
      const [startPromise] = await startCore()
      startPromise.then(async () => {
        await initProfileUpdater()
      })
      coreStarted = true
    } catch (e) {
      showError(t('dialog.coreStartError'), `${e}`)
    }
  })()

  await createWindowPromise

  const uiTasks: Promise<void>[] = [initShortcut()]

  if (showFloating) {
    uiTasks.push(Promise.resolve(showFloatingWindow()))
  }
  if (!disableTray) {
    uiTasks.push(createTray())
  }

  await Promise.all(uiTasks)

  await Promise.all([coreStartPromise])

  if (coreStarted) {
    mainWindow?.webContents.send('core-started')
  }

  if (needsFirstRunAdmin) {
    mainWindow?.webContents.send('needs-admin-setup')
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    showMainWindow()
  })
})

function sendConnectStatus(progress: ConnectStatusEvent): void {
  safeSend(mainWindow, 'subscription-connect-status', progress)
}

// Both ways of signing in end the same way: fetch the subscription and import
// it, reporting every step on the card the person is already looking at.
async function runAndImport(
  run: (report: (progress: ConnectStatusEvent) => void) => Promise<{ url: string; name?: string }>
): Promise<void> {
  const pending = getPendingSubscriptionConnect()
  if (pending) {
    // Already in progress. Show where it stands instead of starting a second
    // round trip and calling the first one a failure.
    sendConnectStatus(pending)
    return
  }
  try {
    const { url, name } = await run(sendConnectStatus)
    sendConnectStatus({ status: 'importing' })
    await importSubscription(url, name)
  } catch (e) {
    sendConnectStatus({ status: 'failed', message: e instanceof Error ? e.message : `${e}` })
  }
}

// Returns false when the stored session no longer works, so the caller can
// ask the person to sign in instead of reporting a dead end.
async function importFromSession(): Promise<boolean> {
  try {
    const { url, name } = await runSubscriptionFromSession(sendConnectStatus)
    sendConnectStatus({ status: 'importing' })
    await importSubscription(url, name)
    return true
  } catch {
    return false
  }
}

// The single door into "add a subscription", used by the website link and by
// the tray. Someone who signed in before gets the subscription without typing
// anything; everyone else gets the sign-in dialog.
export async function openSubscriptionEntry(): Promise<void> {
  await showMainWindow()
  // A link arriving while a sign-in is already running must not start a second
  // one, and above all must not ask to sign in again: the website fires its
  // redirect at exactly the moment the poll is still waiting for the answer.
  const pending = getPendingSubscriptionConnect()
  if (pending) {
    sendConnectStatus(pending)
    return
  }
  if (hasCabinetSession() && (await importFromSession())) {
    return
  }
  // No session, or the stored one is dead — ask to sign in rather than report
  // a dead end the person can do nothing about.
  safeSend(mainWindow, 'open-subscription-login')
}

// Выход из аккаунта отключает ВСЁ, что дал аккаунт.
//
// Сначала я развёл сессию кабинета и подписку: мол, человек, отключивший
// аккаунт, не должен остаться без интернета. Владелец поправил, и он прав:
// «авторизовался — появилось всё, вышел — всё отключилось». Половинчатый
// выход выглядел именно так, как он и описал: устройства пропали, а серверы
// и название тарифа остались, и было непонятно, вышел ты или нет.
//
// Удаляем только УДАЛЁННЫЕ профили: локальный конфиг из файла человек принёс
// сам, аккаунт к нему отношения не имеет, и стирать чужое мы не вправе.
// Когда исчезает последний профиль, туннель гасится существующей логикой
// внутри removeProfileItem — отдельно выключать ничего не нужно.
export async function disconnectAccount(): Promise<void> {
  signOutOfCabinet()
  const { items } = await getProfileConfig()
  for (const item of items.filter((i) => i.type === 'remote')) {
    await removeProfileItem(item.id)
  }
  safeSend(mainWindow, 'profileConfigUpdated')
}

export async function startSubscriptionConnect(): Promise<void> {
  await runAndImport((report) => runSubscriptionConnect(report, 'telegram'))
}

// Signing in through the browser the person is already signed into. Same token
// and same poll as the Telegram route — only the page they confirm on differs.
export async function startWebsiteLogin(): Promise<void> {
  await runAndImport((report) => runSubscriptionConnect(report, 'website'))
}

export async function startEmailLogin(email: string, password: string): Promise<void> {
  await runAndImport((report) => runEmailLogin(email, password, report))
}

// Shared by both deep link hosts. Reports the HWID limit through its own screen
// because that case is actionable by the user, unlike a generic failure.
async function importSubscription(
  profileUrl: string,
  profileName?: string | null,
  sourceUrl?: string
): Promise<void> {
  try {
    // The same subscription can arrive twice: the person confirms on the
    // website, the poll imports it, and the page's redirect then wakes the app
    // again. Adding it twice would leave two identical profiles and no way for
    // the person to tell which one is live.
    const { items } = await getProfileConfig()
    if (items.some((item) => item.url === profileUrl)) {
      sendConnectStatus({ status: 'done' })
      return
    }
    await addProfileItem({
      type: 'remote',
      name: profileName ?? undefined,
      url: profileUrl
    })
    safeSend(mainWindow, 'profileConfigUpdated')
    new Notification({ title: t('notification.profileImportSuccess') }).show()
    sendConnectStatus({ status: 'done' })
  } catch (e) {
    const hwidLimitMatch = `${e}`.match(/HWID_LIMIT:(.*)/)
    if (hwidLimitMatch) {
      sendConnectStatus({ status: 'failed', message: t('error.connectDeviceLimit') })
      safeSend(mainWindow, 'show-hwid-limit-error', hwidLimitMatch[1].trim())
      return
    }
    sendConnectStatus({ status: 'failed', message: `${e}` })
    // Only the deep link path gets a dialog, and only with the link the person
    // clicked themselves. In the Telegram flow the subscription URL is private
    // and never shown to them — putting it in an error box invites screenshots
    // of a credential into support chats. The card already states the reason.
    if (sourceUrl) {
      showError(t('dialog.profileImportFailed'), `${sourceUrl}\n${e}`)
    }
  }
}

async function handleDeepLink(url: string): Promise<void> {
  if (!isDeepLink(url)) return

  const urlObj = new URL(url)

  switch (urlObj.host) {
    // The website only wakes the app: no subscription link travels through the
    // browser, the address bar or its history. The client fetches it itself,
    // with the session it already has or after a sign-in.
    case 'connect': {
      await openSubscriptionEntry()
      break
    }
    // Links handed to the user elsewhere — the subscription page, support —
    // so the source is unverified and the import is always confirmed first.
    case 'install-config': {
      const profileUrl = urlObj.searchParams.get('url')
      const profileName = urlObj.searchParams.get('name')
      if (!profileUrl) {
        showError(t('dialog.profileImportFailed'), `${url}\n${t('error.missingUrlParam')}`)
        return
      }
      const confirmed = await showProfileInstallConfirm(profileUrl, profileName)
      if (confirmed) {
        await importSubscription(profileUrl, profileName, url)
      }
      break
    }
  }
}

async function showProfileInstallConfirm(url: string, name?: string | null): Promise<boolean> {
  if (!mainWindow) {
    await createWindow()
  }
  let extractedName = name

  if (!extractedName) {
    try {
      const axios = (await import('axios')).default
      const response = await axios.head(url, {
        timeout: 5000
      })

      if (response.headers['profile-title']) {
        const titleValue = response.headers['profile-title']
        if (titleValue.startsWith('base64:')) {
          extractedName = Buffer.from(titleValue.slice(7), 'base64').toString('utf-8')
        } else {
          extractedName = titleValue
        }
      } else {
        if (response.headers['content-disposition']) {
          extractedName = parseFilename(response.headers['content-disposition'])
        }
      }
    } catch (error) {
      // ignore
    }
  }

  return new Promise((resolve) => {
    const delay = showWindow()
    setTimeout(() => {
      mainWindow?.webContents.send('show-profile-install-confirm', {
        url,
        name: extractedName || name
      })
      const handleConfirm = (_event: Electron.IpcMainEvent, confirmed: boolean): void => {
        ipcMain.off('profile-install-confirm-result', handleConfirm)
        resolve(confirmed)
      }
      ipcMain.once('profile-install-confirm-result', handleConfirm)
    }, delay)
  })
}

function parseFilename(str: string): string {
  if (str.match(/filename\*=.*''/)) {
    return decodeURIComponent(str.split(/filename\*=.*''/)[1])
  } else {
    const filename = str.split('filename=')[1]
    return filename?.replace(/"/g, '') || ''
  }
}

// Окно появляется раньше, чем рендерер успевает нарисовать свой фон, и без
// заданного цвета Chromium подставляет белый — отсюда вспышка при каждой
// перезагрузке рендерера (её делают обработчики did-fail-load и
// render-process-gone ниже). На macOS фон обязан быть прозрачным, иначе он
// закроет нативный материал окна; на остальных платформах прозрачности нет,
// поэтому берём базовый тон выбранной темы.
function resolveWindowBackground(appTheme: AppTheme = 'system'): string {
  if (process.platform === 'darwin') return '#00000000'
  const dark = appTheme === 'system' ? nativeTheme.shouldUseDarkColors : appTheme === 'dark'
  return dark ? '#0a0f1a' : '#F7E7CE'
}

export async function createWindow(appConfig?: AppConfig): Promise<void> {
  if (isCreatingWindow) {
    if (createWindowPromise) {
      await createWindowPromise
    }
    return
  }
  isCreatingWindow = true
  createWindowPromise = new Promise<void>((resolve) => {
    createWindowPromiseResolve = resolve
  })
  try {
    const config = appConfig ?? (await getAppConfig())
    const { useWindowFrame = false } = config

    const [mainWindowState] = await Promise.all([
      Promise.resolve(
        windowStateKeeper({
          // Оболочка «один экран»: кнопка, строка подписки и список серверов.
          // Широкое окно от старой раскладки с сайдбаром растягивало список
          // в пустую простыню, поэтому размер по умолчанию — вертикальный.
          defaultWidth: 460,
          defaultHeight: 720,
          file: 'window-state.json'
        })
      ),
      process.platform === 'darwin'
        ? createApplicationMenu()
        : Promise.resolve(Menu.setApplicationMenu(null))
    ])
    // Светофор на macOS рисует система, и 'hiddenInset' — единственный режим,
    // который отдаёт содержимому всё окно, но оставляет кнопки на месте и
    // сдвинутыми внутрь по системным отступам (trafficLightPosition не задаём:
    // свои числа разъедутся с системными в следующей macOS). Рамку при этом
    // снимать нельзя: frame:false на macOS убирает кнопки вместе с ней.
    // Windows и Linux остаются на своей рамке — там оболочка рисует всё сама.
    const nativeTitleBar = process.platform === 'darwin' && !useWindowFrame
    const titleBarStyle: Electron.BrowserWindowConstructorOptions['titleBarStyle'] = useWindowFrame
      ? 'default'
      : nativeTitleBar
        ? 'hiddenInset'
        : 'hidden'

    // Фон окна отдан нативному материалу: карты мира на подложке больше нет,
    // а полупрозрачные поверхности оболочки должны стоять на чём-то живом.
    // Только darwin — на Windows и Linux этих опций просто нет, и передавать
    // их туда незачем.
    const darwinMaterial: Electron.BrowserWindowConstructorOptions =
      process.platform === 'darwin'
        ? { vibrancy: 'under-window', visualEffectState: 'followWindow' }
        : {}

    mainWindow = new BrowserWindow({
      // Минимум держим по содержимому одного экрана, а не по старой раскладке
      // с сайдбаром: 800×600 не давали поставить окно узкой полосой у края.
      minWidth: 420,
      minHeight: 560,
      width: mainWindowState.width,
      height: mainWindowState.height,
      x: mainWindowState.x,
      y: mainWindowState.y,
      show: false,
      frame: useWindowFrame || nativeTitleBar,
      titleBarStyle,
      titleBarOverlay: false,
      autoHideMenuBar: true,
      backgroundColor: resolveWindowBackground(config.appTheme),
      ...darwinMaterial,
      ...(process.platform === 'linux' ? { icon: icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        spellcheck: false,
        sandbox: false
      }
    })
    mainWindowState.manage(mainWindow)
    mainWindow.on('maximize', () => {
      mainWindow?.webContents.send('window-maximized')
    })
    // В полном экране системная полоса и светофор уезжают, и верхняя полоса
    // перетаскивания вместе с кнопками окна остаётся висеть поверх содержимого
    // пустым отступом. Рендерер сам её убирает, но узнать о переходе он может
    // только отсюда.
    // Спрашиваем именно то окно, к которому подписались: режим экономии
    // выгружает окно целиком, и к моменту события mainWindow может указывать
    // уже на другое.
    const createdWindow = mainWindow
    const sendFullscreenState = (): void => {
      if (createdWindow.isDestroyed()) return
      safeSend(createdWindow, 'window-fullscreen', createdWindow.isFullScreen())
    }
    mainWindow.on('enter-full-screen', sendFullscreenState)
    mainWindow.on('leave-full-screen', sendFullscreenState)
    // Перезагрузка рендерера (did-fail-load, render-process-gone) начинает
    // разметку с нуля, и окно в полном экране осталось бы с полосой сверху:
    // событие перехода к тому моменту давно прошло.
    mainWindow.webContents.on('did-finish-load', sendFullscreenState)
    mainWindow.on('ready-to-show', async () => {
      const { silentStart = false } = await getAppConfig()
      if (!silentStart) {
        if (quitTimeout) {
          clearTimeout(quitTimeout)
        }
        windowShown = true
        mainWindow?.show()
        mainWindow?.focusOnWebView()
      } else {
        await scheduleLightweightMode()
      }
    })
    mainWindow.webContents.on('did-fail-load', () => {
      mainWindow?.webContents.reload()
    })

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        mainWindow.webContents.reload()
      } catch {
        // ignore
      }
    })

    mainWindow.webContents.on('unresponsive', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        mainWindow.webContents.forcefullyCrashRenderer()
        mainWindow.webContents.reload()
      } catch {
        // ignore
      }
    })

    mainWindow.on('focus', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        mainWindow.webContents.invalidate()
      } catch {
        // ignore
      }
    })

    mainWindow.on('show', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        mainWindow.webContents.invalidate()
      } catch {
        // ignore
      }
    })

    mainWindow.webContents.once('did-finish-load', () => {
      if (pendingDeepLink) {
        const url = pendingDeepLink
        pendingDeepLink = null
        setTimeout(() => {
          handleDeepLink(url)
        }, 500)
      }
    })

    mainWindow.on('close', async (event) => {
      event.preventDefault()
      mainWindow?.hide()
      if (windowShown) {
        await scheduleLightweightMode()
      }
    })

    mainWindow.on('closed', () => {
      mainWindow = null
    })

    mainWindow.on('resized', () => {
      if (mainWindow) mainWindowState.saveState(mainWindow)
    })

    mainWindow.on('unmaximize', () => {
      if (mainWindow) mainWindowState.saveState(mainWindow)
      mainWindow?.webContents.send('window-unmaximized')
    })

    mainWindow.on('move', () => {
      if (mainWindow) mainWindowState.saveState(mainWindow)
    })

    mainWindow.on('session-end', async () => {
      triggerSysProxy(false, false)
      await stopCore()
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })
    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  } finally {
    isCreatingWindow = false
    if (createWindowPromiseResolve) {
      createWindowPromiseResolve()
      createWindowPromiseResolve = null
    }
    createWindowPromise = null
  }
}

export async function triggerMainWindow(): Promise<void> {
  if (mainWindow && mainWindow.isVisible()) {
    closeMainWindow()
  } else {
    await showMainWindow()
  }
}

export async function showMainWindow(): Promise<void> {
  if (quitTimeout) {
    clearTimeout(quitTimeout)
  }
  if (process.platform === 'darwin' && app.dock) {
    const { useDockIcon = true } = await getAppConfig()
    if (!useDockIcon) {
      app.dock.hide()
    }
  }
  if (mainWindow) {
    windowShown = true
    mainWindow.show()
    mainWindow.focusOnWebView()
  } else {
    await createWindow()
    if (mainWindow !== null) {
      windowShown = true
      ;(mainWindow as BrowserWindow).show()
      ;(mainWindow as BrowserWindow).focusOnWebView()
    }
  }
}

export function closeMainWindow(): void {
  if (mainWindow) {
    mainWindow.close()
  }
}
