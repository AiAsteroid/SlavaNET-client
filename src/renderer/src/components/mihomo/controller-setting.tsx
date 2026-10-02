import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import {
  CloudDownload,
  Code,
  Globe,
  KeyRound,
  MonitorCog,
  Network,
  RefreshCcw,
  Shield
} from 'lucide-react'
import { FieldRow, Group, Row, SelectRow, SwitchRow } from '@renderer/components/shell/list-group'
import EditableList from '../base/base-list-editor'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { mihomoUpgradeUI, mihomoHotReloadConfig } from '@renderer/utils/ipc'
import { isValidListenAddress } from '@renderer/utils/validate'

// Внешний контроллер на общем наборе строк (shell/list-group).
//
// Было: одна карточка из шести строк старого вида, четыре кнопки «Подтвердить»
// и четыре значка 24×24 в правых углах строк — «сгенерировать ключ», «обновить
// панель», «открыть в браузере», «показать ключ». Угадать их можно было только
// наведением, а подпись «Настройки CORS» занимала отдельную пустую строку.
//
// Стало: четыре группы со строками того же вида, что на остальных экранах. Все
// шесть настроек на месте, значки превратились в обычные строки-действия с
// именами из тех же ключей перевода, а «Настройки CORS» стала заголовком своей
// группы.
//
// ⚠️ Заголовки групп взяты из СУЩЕСТВУЮЩИХ ключей перевода: локали правит
// другой человек, новых ключей здесь не появляется.
//
// ⚠️ Кнопок «Подтвердить» рядом с полем больше нет (решение владельца
// 02.10.2026): все четыре появлялись только при изменении значения. Поле
// применяет правку по уходу и по Enter (FieldRow), а «сгенерировать ключ»
// пишет ключ сразу — иначе кнопка выдавала бы ключ, который никуда не уходит.
//
// ⚠️ Глазок «показать ключ» ушёл вместе с полем-паролем: режима пароля у
// FieldRow нет, а добавить его может только владелец набора строк. Ключ теперь
// виден всегда — это ключ к локальному API на 127.0.0.1, и его как раз надо
// прочитать глазами, чтобы вставить в стороннюю панель.

/** Пауза в наборе, после которой список записывается в конфиг, мс. */
const LIST_COMMIT_MS = 600

// Отложенная запись списка. Копия заготовки из
// components/settings/advanced-settings.tsx — правя её там, правь и здесь.
//
// ⚠️ Без неё правка уходила в конфиг на КАЖДЫЙ символ: EditableList зовёт
// onChange на каждое нажатие, а здесь следом ещё и перезагружается
// конфигурация ядра. Раньше от этого спасала кнопка «Подтвердить», но кнопок
// рядом с полем у нас больше нет, и паузу надо держать здесь.
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

// Адреса панелей: тот же список, что стоял в старом селекте, в том же порядке.
const uiOptions = [
  {
    value: 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip',
    label: 'zashboard'
  },
  {
    value: 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip',
    label: 'metacubexd'
  },
  {
    value: 'https://github.com/MetaCubeX/Yacd-meta/archive/refs/heads/gh-pages.zip',
    label: 'yacd-meta'
  },
  { value: 'https://github.com/haishanh/yacd/archive/refs/heads/gh-pages.zip', label: 'yacd' },
  {
    value: 'https://github.com/MetaCubeX/Razord-meta/archive/refs/heads/gh-pages.zip',
    label: 'razord-meta'
  }
]

const ControllerSetting: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const {
    'external-controller': externalController = '',
    'external-ui': externalUi = '',
    'external-ui-url': externalUiUrl = '',
    'external-controller-cors': externalControllerCors,
    secret
  } = controledMihomoConfig || {}
  const {
    'allow-origins': allowOrigins = [],
    'allow-private-network': allowPrivateNetwork = true
  } = externalControllerCors || {}

  const initialAllowOrigins = allowOrigins.length == 1 && allowOrigins[0] == '*' ? [] : allowOrigins
  const [allowOriginsInput, setAllowOriginsInput] = useState(initialAllowOrigins)
  const [enableExternalUi, setEnableExternalUi] = useState(externalUi == 'ui')
  const [upgrading, setUpgrading] = useState(false)
  const commitAllowOrigins = useDeferredCommit()
  // ⚠️ Счётчик снимает отвергнутую правку адреса. Проверка формата раньше жила
  // в подсказке у поля и гасила кнопку «Подтвердить»; кнопки нет, поэтому
  // негодный адрес просто не применяется — а поле надо вернуть к тому, что
  // реально стоит в конфиге, иначе на экране осталась бы ложь. Смена key
  // пересобирает строку, и её черновик снова берётся из конфига.
  const [addressRevision, setAddressRevision] = useState(0)

  const upgradeUI = async (): Promise<void> => {
    try {
      setUpgrading(true)
      await mihomoUpgradeUI()
      new Notification(t('mihomo.controllerSettings.panelUpdateSuccess'))
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      setUpgrading(false)
    }
  }
  const onChangeNeedRestart = async (patch: Partial<MihomoConfig>): Promise<void> => {
    await patchControledMihomoConfig(patch)
    await mihomoHotReloadConfig()
    if ('external-ui-url' in patch) {
      setTimeout(async () => {
        await upgradeUI()
      }, 1000)
    }
  }
  const generateRandomString = (length: number): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  }

  // Сборка адреса панели — перенесена из обработчика кнопки-значка без
  // изменений: у разных панелей свой путь и свой способ принять ключ.
  const openPanel = (): void => {
    const controller = externalController.startsWith(':')
      ? `127.0.0.1${externalController}`
      : externalController
    const host = controller.split(':')[0]
    const port = controller.split(':')[1]
    if (['zashboard', 'metacubexd'].find((keyword) => externalUiUrl.includes(keyword))) {
      open(`http://${controller}/ui/#/setup?hostname=${host}&port=${port}&secret=${secret}`)
    } else if (externalUiUrl.includes('Razord')) {
      open(`http://${controller}/ui/#/proxies?host=${host}&port=${port}&secret=${secret}`)
    } else {
      if (secret && secret.length > 0) {
        open(`http://${controller}/ui/?hostname=${host}&port=${port}&secret=${secret}`)
      } else {
        open(`http://${controller}/ui/?hostname=${host}&port=${port}`)
      }
    }
  }

  const hasController = !!externalController && externalController !== ''

  return (
    <>
      <Group title={t('mihomo.controllerSettings.externalController')}>
        <FieldRow
          key={`external-controller-${addressRevision}`}
          icon={Network}
          label={t('mihomo.controllerSettings.listenAddress')}
          value={externalController}
          width={140}
          onCommit={async (next) => {
            const r = isValidListenAddress(next)
            if (!r.ok) {
              toast.error(r.error ?? t('mihomo.controllerSettings.formatError'))
              setAddressRevision((n) => n + 1)
              return
            }
            await onChangeNeedRestart({ 'external-controller': next })
          }}
        />
        {hasController && (
          <FieldRow
            icon={KeyRound}
            label={t('mihomo.controllerSettings.accessSecret')}
            value={secret ?? ''}
            width={150}
            onCommit={async (next) => {
              await onChangeNeedRestart({ secret: next })
            }}
          />
        )}
        {hasController && (
          <Row
            icon={RefreshCcw}
            label={t('mihomo.controllerSettings.generateSecret')}
            trailing="chevron"
            onClick={() => {
              void onChangeNeedRestart({ secret: generateRandomString(32) })
            }}
          />
        )}
      </Group>

      {hasController && (
        <>
          <Group title={t('mihomo.controllerSettings.controllerPanel')}>
            <SwitchRow
              icon={MonitorCog}
              label={t('mihomo.controllerSettings.enableControllerPanel')}
              checked={enableExternalUi}
              onCheckedChange={(v) => {
                setEnableExternalUi(v)
                onChangeNeedRestart({
                  'external-ui': v ? 'ui' : undefined
                })
              }}
            />
            {enableExternalUi && (
              <>
                {/* Выбор панели применяется сразу, и ядро тут же её скачивает
                    (onChangeNeedRestart выше): без этого в конфиге оставался бы
                    адрес одной панели, а на диске — файлы другой. */}
                <SelectRow
                  icon={Code}
                  label={t('mihomo.controllerSettings.controllerPanel')}
                  value={externalUiUrl}
                  options={uiOptions}
                  onChange={(value) => {
                    onChangeNeedRestart({ 'external-ui-url': value })
                  }}
                />
                <Row
                  icon={CloudDownload}
                  label={t('mihomo.controllerSettings.updatePanel')}
                  busy={upgrading}
                  disabled={upgrading}
                  trailing="chevron"
                  onClick={upgradeUI}
                />
                <Row
                  icon={Globe}
                  label={t('mihomo.controllerSettings.openInBrowser')}
                  className="app-nodrag"
                  trailing="external"
                  onClick={openPanel}
                />
              </>
            )}
          </Group>

          <Group title={t('mihomo.controllerSettings.corsConfig')}>
            <SwitchRow
              icon={Shield}
              label={t('mihomo.controllerSettings.allowPrivateNetwork')}
              checked={allowPrivateNetwork}
              onCheckedChange={(v) => {
                onChangeNeedRestart({
                  'external-controller-cors': {
                    ...externalControllerCors,
                    'allow-private-network': v
                  }
                })
              }}
            />
          </Group>

          {/* Пустой список источников значит «любой»: в конфиг уходит '*'.
              Поведение от upstream, перенесено как было. */}
          <Group title={t('mihomo.controllerSettings.allowedOrigins')}>
            <div className="px-3 py-2">
              <EditableList
                items={allowOriginsInput}
                divider={false}
                onChange={(items) => {
                  const next = items as string[]
                  setAllowOriginsInput(next)
                  commitAllowOrigins(() =>
                    onChangeNeedRestart({
                      'external-controller-cors': {
                        ...externalControllerCors,
                        'allow-origins': next.length == 0 ? ['*'] : next
                      }
                    })
                  )
                }}
              />
            </div>
          </Group>
        </>
      )}
    </>
  )
}

export default ControllerSetting
