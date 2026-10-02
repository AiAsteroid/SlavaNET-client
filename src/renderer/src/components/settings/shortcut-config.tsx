import React, { KeyboardEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  Globe,
  ListTree,
  LogOut,
  Network,
  PictureInPicture2,
  RotateCcw,
  Unplug
} from 'lucide-react'
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { Group } from '@renderer/components/shell/list-group'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { platform } from '@renderer/utils/init'
import { registerShortcut } from '@renderer/utils/ipc'
import { cn } from '@renderer/lib/utils'

const keyMap = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Plus: 'PLUS',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
  Backspace: 'Backspace',
  CapsLock: 'Capslock',
  ContextMenu: 'Contextmenu',
  Space: 'Space',
  Tab: 'Tab',
  Convert: 'Convert',
  Delete: 'Delete',
  End: 'End',
  Help: 'Help',
  Home: 'Home',
  PageDown: 'Pagedown',
  PageUp: 'Pageup',
  Escape: 'Esc',
  PrintScreen: 'Printscreen',
  ScrollLock: 'Scrolllock',
  Pause: 'Pause',
  Insert: 'Insert',
  Suspend: 'Suspend'
}

// Горячие клавиши, девять штук, на общем наборе строк (shell/list-group).
//
// Раньше это была одна плоская карточка из девяти безымянных строк: окно,
// плавающее окно, прокси, TUN, три режима маршрутизации и два выхода лежали
// подряд, и глазу было не за что зацепиться. Теперь те же девять разбиты на
// четыре группы по смыслу, заголовки взяты из существующих ключей перевода —
// новых ключей здесь не заводится, локали правит другой человек.
const ShortcutConfig: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    showWindowShortcut = '',
    showFloatingWindowShortcut = '',
    triggerSysProxyShortcut = '',
    triggerTunShortcut = '',
    ruleModeShortcut = '',
    globalModeShortcut = '',
    directModeShortcut = '',
    quitWithoutCoreShortcut = '',
    restartAppShortcut = ''
  } = appConfig || {}

  return (
    <>
      <Group title={t('pages.settings.groupApp')}>
        <ShortcutRow
          icon={AppWindow}
          label={t('settings.shortcuts.toggleWindow')}
          value={showWindowShortcut}
          action="showWindowShortcut"
          patchAppConfig={patchAppConfig}
        />
        <ShortcutRow
          icon={PictureInPicture2}
          label={t('settings.shortcuts.toggleFloatingWindow')}
          value={showFloatingWindowShortcut}
          action="showFloatingWindowShortcut"
          patchAppConfig={patchAppConfig}
        />
      </Group>

      <Group title={t('pages.settings.groupConnection')}>
        <ShortcutRow
          icon={Globe}
          label={t('settings.shortcuts.toggleSysProxy')}
          value={triggerSysProxyShortcut}
          action="triggerSysProxyShortcut"
          patchAppConfig={patchAppConfig}
        />
        <ShortcutRow
          icon={Network}
          label={t('settings.shortcuts.toggleTun')}
          value={triggerTunShortcut}
          action="triggerTunShortcut"
          patchAppConfig={patchAppConfig}
        />
      </Group>

      <Group title={t('pages.more.app.routing')}>
        <ShortcutRow
          icon={ListTree}
          label={t('settings.shortcuts.switchRuleMode')}
          value={ruleModeShortcut}
          action="ruleModeShortcut"
          patchAppConfig={patchAppConfig}
        />
        <ShortcutRow
          icon={Globe}
          label={t('settings.shortcuts.switchGlobalMode')}
          value={globalModeShortcut}
          action="globalModeShortcut"
          patchAppConfig={patchAppConfig}
        />
        <ShortcutRow
          icon={Unplug}
          label={t('settings.shortcuts.switchDirectMode')}
          value={directModeShortcut}
          action="directModeShortcut"
          patchAppConfig={patchAppConfig}
        />
      </Group>

      <Group title={t('pages.settings.groupMaintenance')}>
        <ShortcutRow
          icon={LogOut}
          label={t('settings.shortcuts.quitKeepCore')}
          value={quitWithoutCoreShortcut}
          action="quitWithoutCoreShortcut"
          patchAppConfig={patchAppConfig}
        />
        <ShortcutRow
          icon={RotateCcw}
          label={t('settings.shortcuts.restartApp')}
          value={restartAppShortcut}
          action="restartAppShortcut"
          patchAppConfig={patchAppConfig}
        />
      </Group>
    </>
  )
}

// ⚠️ Геометрия строки списана с FieldRow (shell/list-group): высота 40, те же
// отступы и тот же зазор. Константы SHELL/H_ONE оттуда не экспортируются, и
// копия здесь — единственный способ не разъехаться с остальными формами
// строки. Правя их там, правь и здесь.
// Геометрия повторяет SHELL/H_ONE из набора строк: min-h, чтобы длинная
// подпись переносилась, а не обрезалась посередине слова.
const ROW = 'flex min-h-10 w-full items-center gap-2.5 px-3 py-1 text-left transition-colors'

// Строка горячей клавиши — седьмая форма, и единственная своя: ловец нажатий
// не текстовое поле, FieldRow им быть не может. Поэтому ряд собран вручную по
// образцу FieldRow, а ловец стоит в нём на месте поля ввода и выглядит так же.
//
// ⚠️ Кнопки «Подтвердить» рядом больше нет (решение владельца 02.10.2026, то
// же, что и для полей ввода). Сочетание применяется по уходу из ловца, и только
// по уходу: Enter, Tab и Esc для него не команды, а такие же ловимые клавиши,
// как любая другая, — разбор нажатий перенесён из старого ShortcutInput без
// изменений, вместе с этим его свойством. Вместе с кнопкой ушло состояние
// activeAction: оно существовало только затем, чтобы откатывать
// НЕподтверждённую правку в остальных восьми строках, а неподтверждённых
// правок больше не бывает.
const ShortcutRow: React.FC<{
  icon: typeof AppWindow
  label: string
  value: string
  action: string
  patchAppConfig: (value: Partial<AppConfig>) => Promise<void>
}> = ({ icon: Icon, label, value, action, patchAppConfig }) => {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  const displayKeys = draft.split('+').filter(Boolean)

  useEffect(() => {
    setDraft(value)
  }, [value])

  // ⚠️ Откат при отказе обязателен: без кнопки «Подтвердить» строка — это и
  // есть единственное свидетельство того, какое сочетание работает. Оставив на
  // виду незарегистрированное, мы бы показывали человеку клавишу, которой нет.
  const commit = async (): Promise<void> => {
    if (draft === value) return
    setBusy(true)
    try {
      if (await registerShortcut(value, draft, action)) {
        await patchAppConfig({ [action]: draft })
        window.electron.ipcRenderer.send('updateTrayMenu')
      } else {
        setDraft(value)
        toast.error(t('settings.shortcuts.registerFailed'))
      }
    } catch (e) {
      setDraft(value)
      toast.error(`${t('settings.shortcuts.registerFailedWithError')}${e}`)
    } finally {
      setBusy(false)
    }
  }

  const parseShortcut = (
    event: KeyboardEvent<HTMLElement>,
    setKey: { (value: React.SetStateAction<string>): void; (arg0: string): void }
  ): void => {
    event.preventDefault()
    let code = event.code
    const key = event.key
    if (code === 'Backspace') {
      setKey('')
    } else {
      let newValue = ''
      if (event.ctrlKey) {
        newValue = 'Ctrl'
      }
      if (event.shiftKey) {
        newValue = `${newValue}${newValue.length > 0 ? '+' : ''}Shift`
      }
      if (event.metaKey) {
        newValue = `${newValue}${newValue.length > 0 ? '+' : ''}${platform === 'darwin' ? 'Command' : 'Super'}`
      }
      if (event.altKey) {
        newValue = `${newValue}${newValue.length > 0 ? '+' : ''}Alt`
      }
      if (code.startsWith('Key')) {
        code = code.substring(3)
      } else if (code.startsWith('Digit')) {
        code = code.substring(5)
      } else if (code.startsWith('Arrow')) {
        code = code.substring(5)
      } else if (key.startsWith('Arrow')) {
        code = key.substring(5)
      } else if (code.startsWith('Intl')) {
        code = code.substring(4)
      } else if (code.startsWith('Numpad')) {
        if (key.length === 1) {
          code = 'Num' + code.substring(6)
        } else {
          code = key
        }
      } else if (/F\d+/.test(code)) {
        // f1-f12
      } else if (keyMap[code] !== undefined) {
        code = keyMap[code]
      } else {
        code = ''
      }
      setKey(`${newValue}${newValue.length > 0 && code.length > 0 ? '+' : ''}${code}`)
    }
  }

  return (
    <div className={ROW}>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 overflow-hidden text-sm text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
        {label}
      </span>
      {busy && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
      {/* ⚠️ Кольцо фокуса здесь на состоянии, а не на focus-visible: ловец
          берут и мышью, и кольцо — единственный признак того, что он уже
          слушает клавиши. Кольцо именно ring-inset: карточка группы обрезает
          содержимое, и кольцо с отступом срезалось бы её краем у первой и
          последней строки. То же правило, что в shell/list-group.
          ⚠️ Ширина ограничена, а подсказка обрезается: в окне 420px (минимум,
          src/main/index.ts:693) полный текст подсказки съел бы всю строку. */}
      <button
        type="button"
        aria-label={`${label}: ${draft || t('settings.shortcuts.clickToInput')}`}
        title={t('settings.shortcuts.clickToInput')}
        className={cn(
          'flex h-[26px] max-w-[46%] shrink-0 cursor-pointer items-center justify-end gap-1',
          'overflow-hidden rounded-md bg-secondary px-2 text-sm outline-none',
          focused && 'ring-2 ring-inset ring-primary'
        )}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>): void => {
          parseShortcut(e, setDraft)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          void commit()
        }}
      >
        {displayKeys.length > 0 ? (
          <KbdGroup>
            {displayKeys.map((k, index) => (
              <Kbd key={`${k}-${index}`}>{k}</Kbd>
            ))}
          </KbdGroup>
        ) : (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {t('settings.shortcuts.clickToInput')}
          </span>
        )}
      </button>
    </div>
  )
}

export default ShortcutConfig
