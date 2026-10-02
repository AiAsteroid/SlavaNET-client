import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Copy,
  Cpu,
  Feather,
  FolderTree,
  Globe,
  Minimize2,
  RefreshCw,
  ScanSearch,
  Settings as SettingsIcon,
  Terminal,
  Timer,
  WifiOff
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  FieldRow,
  Group,
  Row,
  SegmentRow,
  SelectRow,
  SwitchRow
} from '@renderer/components/shell/list-group'
import EditableList from '../base/base-list-editor'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { platform } from '@renderer/utils/init'
import {
  copyEnv,
  mihomoHotReloadConfig,
  patchControledMihomoConfig,
  restartCore,
  startNetworkDetection,
  stopNetworkDetection
} from '@renderer/utils/ipc'

const emptyArray: string[] = []
type EnvType = 'bash' | 'cmd' | 'powershell' | 'nushell'

const envOptions: Array<{ value: EnvType; label: string }> = [
  { value: 'bash', label: 'Bash' },
  { value: 'cmd', label: 'CMD' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'nushell', label: 'NuShell' }
]

interface AdvancedSettingsProps {
  showHiddenSettings: boolean
}

// Расширенные настройки на общем наборе строк (src/components/shell/list-group).
// Раньше это был один свёрнутый аккордеон из тринадцати строк подряд:
// облегчённый режим, ядро, проверка сети и два списка лежали в одной куче, без
// заголовков, а половина пояснений была спрятана под вопросики.
//
// Теперь шесть групп по смыслу, и все тринадцать настроек на месте:
// «Приложение» (3), «Настройки ядра» (5), «Подключение» (2), по группе на
// каждый список-редактор (2) и служебная группа с форматом переменных
// окружения (1).
//
// ⚠️ Заголовки групп взяты из СУЩЕСТВУЮЩИХ ключей перевода: локали правит
// другой человек, новых ключей здесь не появляется. Поэтому «Настройки ядра» —
// это settings.actions.mihomoSettings, а служебная группа идёт под
// pages.settings.groupMaintenance.
//
// ⚠️ Кнопок «Подтвердить» больше нет (решение владельца 02.10.2026). Их было
// три, и каждая появлялась только при изменении значения. Поле применяет
// правку по уходу и по Enter (FieldRow), а списки — с паузой после набора
// (useDeferredCommit ниже): иначе настройка просто перестала бы сохраняться.
/** Пауза в наборе, после которой список записывается в конфиг, мс. */
const LIST_COMMIT_MS = 600

// Отложенная запись списка.
//
// ⚠️ Без неё правка уходила в конфиг на КАЖДЫЙ символ: EditableList зовёт
// onChange на каждое нажатие, а у списка исключений следом ещё и
// перезапускалась проверка сети. Раньше от этого спасала кнопка
// «Подтвердить», но кнопок рядом с полем у нас больше нет, и паузу надо
// держать здесь. У каждого списка свой таймер: один на двоих отменял бы
// чужую правку.
function useDeferredCommit(): (run: () => void | Promise<unknown>) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return (run) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void run()
    }, LIST_COMMIT_MS)
  }
}

const AdvancedSettings: React.FC<AdvancedSettingsProps> = (props) => {
  const { showHiddenSettings } = props
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    diffWorkDir = false,
    useHotReloadProfile = true,
    controlDns = true,
    controlSniff = true,
    pauseSSID,
    mihomoCpuPriority = 'PRIORITY_NORMAL',
    autoLightweight = false,
    autoLightweightDelay = 60,
    autoLightweightMode = 'core',
    envType = [platform === 'win32' ? 'powershell' : 'bash'],
    networkDetection = false,
    networkDetectionBypass = ['VMware', 'vEthernet'],
    networkDetectionInterval = 10
  } = appConfig || {}

  const pauseSSIDArray = pauseSSID ?? emptyArray

  // Черновики списков. Они нужны не для кнопки, а для самого редактора:
  // patchAppConfig уходит в главный процесс и возвращается через SWR, и список,
  // показанный прямо из конфига, терял бы символы при быстром наборе.
  const [pauseSSIDInput, setPauseSSIDInput] = useState(pauseSSIDArray)
  const [bypass, setBypass] = useState(networkDetectionBypass)
  const commitBypass = useDeferredCommit()
  const commitPauseSSID = useDeferredCommit()

  const envTypeValue = envType as EnvType[]
  const envTypeLabels = envOptions
    .filter((option) => envTypeValue.includes(option.value))
    .map((option) => option.label)
  const envTypeLabel = envTypeLabels.length ? envTypeLabels.join(', ') : '-'

  const priorityOptions: Array<{ value: Priority; label: string }> = [
    { value: 'PRIORITY_HIGHEST', label: t('settings.advanced.realtime') },
    { value: 'PRIORITY_HIGH', label: t('settings.advanced.high') },
    { value: 'PRIORITY_ABOVE_NORMAL', label: t('settings.advanced.aboveNormal') },
    { value: 'PRIORITY_NORMAL', label: t('settings.advanced.normal') },
    { value: 'PRIORITY_BELOW_NORMAL', label: t('settings.advanced.belowNormal') },
    { value: 'PRIORITY_LOW', label: t('settings.advanced.low') }
  ]

  useEffect(() => {
    setPauseSSIDInput(pauseSSIDArray)
  }, [pauseSSIDArray])

  const handleEnvTypeChange = async (value: EnvType, checked: boolean): Promise<void> => {
    const next = checked
      ? Array.from(new Set([...envTypeValue, value]))
      : envTypeValue.filter((item) => item !== value)
    if (next.length === 0) return
    try {
      await patchAppConfig({
        envType: next
      })
    } catch (e) {
      toast.error(`${e}`)
    }
  }

  return (
    <>
      <Group title={t('pages.settings.groupApp')}>
        <SwitchRow
          icon={Feather}
          label={t('settings.advanced.autoEnterLightMode')}
          sub={t('settings.advanced.autoEnterLightModeHelp')}
          checked={autoLightweight}
          onCheckedChange={(value) => {
            patchAppConfig({ autoLightweight: value })
          }}
        />
        {autoLightweight && (
          <>
            <SegmentRow
              icon={Minimize2}
              label={t('settings.advanced.lightModeBehavior')}
              value={autoLightweightMode}
              options={[
                { value: 'core', label: t('settings.advanced.keepCoreOnly') },
                { value: 'tray', label: t('settings.advanced.closeRendererOnly') }
              ]}
              onChange={(value) => {
                patchAppConfig({ autoLightweightMode: value })
                if (value === 'core') {
                  patchAppConfig({ autoLightweightDelay: Math.max(autoLightweightDelay, 5) })
                }
              }}
            />
            {/* Единица измерения раньше жила отдельной плашкой внутри поля;
                теперь она в подписи — ключ перевода тот же. */}
            <FieldRow
              icon={Timer}
              label={`${t('settings.advanced.autoEnterLightModeDelay')}, ${t('settings.advanced.seconds')}`}
              value={autoLightweightDelay.toString()}
              width={72}
              inputMode="numeric"
              onCommit={async (next) => {
                let num = parseInt(next)
                if (isNaN(num)) num = 0
                const minDelay = autoLightweightMode === 'core' ? 5 : 0
                if (num < minDelay) num = minDelay
                await patchAppConfig({ autoLightweightDelay: num })
              }}
            />
          </>
        )}
      </Group>

      <Group title={t('settings.actions.mihomoSettings')}>
        {platform === 'win32' && (
          <SelectRow
            icon={Cpu}
            label={t('settings.advanced.corePriority')}
            value={mihomoCpuPriority}
            options={priorityOptions}
            onChange={async (value) => {
              try {
                await patchAppConfig({
                  mihomoCpuPriority: value
                })
                await restartCore()
              } catch (e) {
                toast.error(`${e}`)
              }
            }}
          />
        )}
        <SwitchRow
          icon={Globe}
          label={t('settings.advanced.takeOverDNS')}
          checked={controlDns}
          onCheckedChange={async (value) => {
            try {
              await patchAppConfig({ controlDns: value })
              await patchControledMihomoConfig({})
              await mihomoHotReloadConfig()
            } catch (e) {
              toast.error(`${e}`)
            }
          }}
          action={{
            icon: SettingsIcon,
            label: t('pages.dns.title'),
            onClick: () => navigate('/dns')
          }}
        />
        <SwitchRow
          icon={ScanSearch}
          label={t('settings.advanced.takeOverSniffer')}
          checked={controlSniff}
          onCheckedChange={async (value) => {
            try {
              await patchAppConfig({ controlSniff: value })
              await patchControledMihomoConfig({})
              await mihomoHotReloadConfig()
            } catch (e) {
              toast.error(`${e}`)
            }
          }}
          action={{
            icon: SettingsIcon,
            label: t('pages.sniffer.title'),
            onClick: () => navigate('/sniffer')
          }}
        />
        <SwitchRow
          icon={RefreshCw}
          label={t('settings.advanced.useHotReloadProfile')}
          sub={t('settings.advanced.useHotReloadProfileHelp')}
          checked={useHotReloadProfile}
          onCheckedChange={(v) => {
            patchAppConfig({ useHotReloadProfile: v })
          }}
        />
        <SwitchRow
          icon={FolderTree}
          label={t('profile.separateWorkDir')}
          sub={t('profile.separateWorkDirHelp')}
          checked={diffWorkDir}
          onCheckedChange={(v) => {
            patchAppConfig({ diffWorkDir: v })
          }}
        />
      </Group>

      <Group title={t('pages.settings.groupConnection')}>
        <SwitchRow
          icon={WifiOff}
          label={t('settings.advanced.stopCoreOnDisconnect')}
          sub={t('settings.advanced.stopCoreOnDisconnectHelp')}
          checked={networkDetection}
          onCheckedChange={(value) => {
            patchAppConfig({ networkDetection: value })
            if (value) {
              startNetworkDetection()
            } else {
              stopNetworkDetection()
            }
          }}
        />
        {networkDetection && (
          <FieldRow
            icon={Timer}
            label={`${t('settings.advanced.disconnectDetectInterval')}, ${t('settings.advanced.seconds')}`}
            value={networkDetectionInterval.toString()}
            width={72}
            inputMode="numeric"
            onCommit={async (next) => {
              let num = parseInt(next)
              // Минимум был у самого поля (min=1): интервал в ноль секунд
              // крутил бы проверку сети без остановки.
              if (isNaN(num) || num < 1) num = 1
              await patchAppConfig({ networkDetectionInterval: num })
              await startNetworkDetection()
            }}
          />
        )}
      </Group>

      {networkDetection && (
        <Group title={t('settings.advanced.bypassDetectInterfaces')}>
          <div className="px-3 py-2">
            <EditableList
              items={bypass}
              divider={false}
              onChange={(list) => {
                const next = list as string[]
                setBypass(next)
                commitBypass(async () => {
                  await patchAppConfig({ networkDetectionBypass: next })
                  await startNetworkDetection()
                })
              }}
            />
          </div>
        </Group>
      )}

      <Group title={t('settings.advanced.directOnSpecificWifi')}>
        <div className="px-3 py-2">
          <EditableList
            items={pauseSSIDInput}
            divider={false}
            onChange={(list) => {
              const next = list as string[]
              setPauseSSIDInput(next)
              commitPauseSSID(() => patchAppConfig({ pauseSSID: next }))
            }}
          />
        </div>
      </Group>

      {showHiddenSettings && (
        <Group title={t('pages.settings.groupMaintenance')}>
          {/* Выбор форматов остался множественным: Row подставляется Radix
              через asChild, поэтому список с галочками работает как раньше. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Row
                icon={Terminal}
                label={t('settings.advanced.copyEnvType')}
                value={envTypeLabel}
                trailing="picker"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {envOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={envTypeValue.includes(option.value)}
                  onCheckedChange={(checked) => handleEnvTypeChange(option.value, checked)}
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Копировать раньше предлагал значок рядом с подписью: по значку
              24×24 не видно, что именно он скопирует. Теперь на каждый
              выбранный формат своя строка. */}
          {envTypeValue.map((type) => (
            <Row
              key={type}
              icon={Copy}
              label={envOptions.find((option) => option.value === type)?.label ?? type}
              onClick={() => copyEnv(type)}
            />
          ))}
        </Group>
      )}
    </>
  )
}

export default AdvancedSettings
