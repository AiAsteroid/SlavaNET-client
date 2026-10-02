import React, { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import {
  AppWindow,
  ArrowUpToLine,
  CloudDownload,
  Code,
  EyeClosed,
  FilePenLine,
  Import,
  Laptop,
  MonitorCog,
  Palette,
  RefreshCw,
  TableOfContents
} from 'lucide-react'
import { Group, Row, SegmentRow, SelectRow, SwitchRow } from '@renderer/components/shell/list-group'
import {
  applyTheme,
  closeFloatingWindow,
  closeTrayIcon,
  fetchThemes,
  getFilePath,
  importThemes,
  isAlwaysOnTop,
  relaunchApp,
  resolveThemes,
  setAlwaysOnTop,
  setDockVisible,
  showFloatingWindow,
  showTrayIcon,
  writeTheme
} from '@renderer/utils/ipc'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { platform } from '@renderer/utils/init'
import { useTheme } from 'next-themes'
import CSSEditorModal from './css-editor-modal'
import { useTranslation } from 'react-i18next'

// Раздел «Внешний вид», переведённый на общий набор строк
// (components/shell/list-group). Было: одна общая карточка на девять строк
// старого вида — с вкладками, селектом и тремя значками-действиями, сложенными
// в правый угол строки «Тема». Стало: две группы со строками того же вида, что
// на остальных экранах.
//
// ⚠️ Подсказки-вопросика у плавающего окна больше нет: её текст
// (showFloatingWindowHelp) переехал во вторую строку самой настройки. Ключ
// перевода тот же — локали правит другой человек.
//
// ⚠️ Три значка в углу строки «Тема» (загрузить, импортировать, править) были
// кнопками 24×24 без подписей: угадать их можно было только наведением. Теперь
// это три обычные строки-действия в той же группе, с именами из тех же ключей.

interface AppearanceConfigProps {
  showHiddenSettings: boolean
}

const AppearanceConfig: React.FC<AppearanceConfigProps> = (props) => {
  const { showHiddenSettings } = props
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const [customThemes, setCustomThemes] = useState<{ key: string; label: string }[]>()
  const [openCSSEditor, setOpenCSSEditor] = useState(false)
  const [fetching, setFetching] = useState(false)
  const { setTheme } = useTheme()
  const {
    useDockIcon = true,
    proxyInTray = true,
    disableTray = false,
    showFloatingWindow: showFloating = false,
    spinFloatingIcon = true,
    useWindowFrame = false,
    customTheme = 'default.css',
    appTheme = 'system'
  } = appConfig || {}
  const [localShowFloating, setLocalShowFloating] = useState(showFloating)
  const [onTop, setOnTop] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    setLocalShowFloating(showFloating)
  }, [showFloating])

  useEffect(() => {
    resolveThemes().then((themes) => {
      setCustomThemes(themes)
    })
    isAlwaysOnTop().then(setOnTop)
  }, [])

  useEffect(() => {
    return (): void => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return (
    <>
      {openCSSEditor && (
        <CSSEditorModal
          theme={customTheme}
          onCancel={() => setOpenCSSEditor(false)}
          onConfirm={async (css: string) => {
            await writeTheme(customTheme, css)
            await applyTheme(customTheme)
            setOpenCSSEditor(false)
          }}
        />
      )}

      <Group title={t('pages.settings.groupApp')}>
        <SwitchRow
          icon={AppWindow}
          label={t('settings.appearance.showFloatingWindow')}
          sub={t('settings.appearance.showFloatingWindowHelp')}
          checked={localShowFloating}
          onCheckedChange={async (value) => {
            if (timeoutRef.current) {
              clearTimeout(timeoutRef.current)
              timeoutRef.current = null
            }

            setLocalShowFloating(value)
            if (value) {
              await showFloatingWindow()
              timeoutRef.current = setTimeout(async () => {
                await patchAppConfig({ showFloatingWindow: value })
                timeoutRef.current = null
              }, 1000)
            } else {
              patchAppConfig({ showFloatingWindow: value })
              await closeFloatingWindow()
            }
          }}
        />
        {localShowFloating && (
          <SwitchRow
            icon={RefreshCw}
            label={t('settings.appearance.rotateFloatingIcon')}
            checked={spinFloatingIcon}
            onCheckedChange={async (value) => {
              await patchAppConfig({ spinFloatingIcon: value })
              window.electron.ipcRenderer.send('updateFloatingWindow')
            }}
          />
        )}
        <SwitchRow
          icon={EyeClosed}
          label={t('settings.appearance.disableTrayIcon')}
          checked={disableTray}
          onCheckedChange={async (value) => {
            await patchAppConfig({ disableTray: value })
            if (value) {
              closeTrayIcon()
            } else {
              showTrayIcon()
            }
          }}
        />
        {platform !== 'linux' && (
          <SwitchRow
            icon={TableOfContents}
            label={t('settings.appearance.trayShowNodeInfo')}
            checked={proxyInTray}
            onCheckedChange={async (value) => {
              await patchAppConfig({ proxyInTray: value })
            }}
          />
        )}
        {platform === 'darwin' && (
          <SwitchRow
            icon={Laptop}
            label={t('settings.appearance.showDockIcon')}
            checked={useDockIcon}
            onCheckedChange={async (value) => {
              await patchAppConfig({ useDockIcon: value })
              setDockVisible(value)
            }}
          />
        )}
        <SwitchRow
          icon={ArrowUpToLine}
          label={t('settings.appearance.alwaysOnTop')}
          checked={onTop}
          onCheckedChange={async (value) => {
            await setAlwaysOnTop(value)
            setOnTop(await isAlwaysOnTop())
          }}
        />
        {/* Переключатель перезапускает приложение: рамку окна Electron меняет
            только при старте. Поведение от upstream, оставлено как было. */}
        <SwitchRow
          icon={MonitorCog}
          label={t('settings.appearance.useSystemTitleBar')}
          checked={useWindowFrame}
          onCheckedChange={async (value) => {
            await patchAppConfig({ useWindowFrame: value })
            await relaunchApp()
          }}
        />
      </Group>

      <Group title={t('settings.appearance.theme')}>
        <SegmentRow
          icon={Palette}
          label={t('settings.appearance.backgroundColor')}
          value={appTheme}
          options={[
            { value: 'system', label: t('settings.appearance.auto') },
            { value: 'dark', label: t('settings.appearance.dark') },
            { value: 'light', label: t('settings.appearance.light') }
          ]}
          onChange={(value) => {
            setTheme(value)
            patchAppConfig({ appTheme: value })
          }}
        />
        {showHiddenSettings && customThemes && (
          <SelectRow
            icon={Code}
            label={t('settings.appearance.theme')}
            value={customTheme}
            options={customThemes.map((theme) => ({ value: theme.key, label: theme.label }))}
            onChange={async (value) => {
              try {
                await patchAppConfig({ customTheme: value })
              } catch (e) {
                toast.error(`${e}`)
              }
            }}
          />
        )}
        {showHiddenSettings && (
          <>
            <Row
              icon={CloudDownload}
              label={t('settings.appearance.pullTheme')}
              busy={fetching}
              disabled={fetching}
              trailing="chevron"
              onClick={async () => {
                setFetching(true)
                try {
                  await fetchThemes()
                  setCustomThemes(await resolveThemes())
                } catch (e) {
                  toast.error(`${e}`)
                } finally {
                  setFetching(false)
                }
              }}
            />
            <Row
              icon={Import}
              label={t('settings.appearance.importTheme')}
              trailing="chevron"
              onClick={async () => {
                const files = await getFilePath(['css'])
                if (!files) return
                try {
                  await importThemes(files)
                  setCustomThemes(await resolveThemes())
                } catch (e) {
                  toast.error(`${e}`)
                }
              }}
            />
            <Row
              icon={FilePenLine}
              label={t('settings.appearance.editTheme')}
              trailing="chevron"
              onClick={() => setOpenCSSEditor(true)}
            />
          </>
        )}
      </Group>
    </>
  )
}

export default AppearanceConfig
