import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge, Globe, MonitorSmartphone, Network, Route, Unplug, Zap } from 'lucide-react'
import { FieldRow, Group, SwitchRow } from '@renderer/components/shell/list-group'
import EditableList from '../base/base-list-editor'
import InterfaceModal from '@renderer/components/mihomo/interface-modal'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { triggerSysProxy, mihomoHotReloadConfig } from '@renderer/utils/ipc'
import { platform } from '@renderer/utils/init'

// Порты ядра на общем наборе строк (shell/list-group).
//
// Было: одна карточка из десяти строк старого вида и девять кнопок
// «Подтвердить» — по одной у каждого порта и по одной у каждого списка. Четыре
// списка-редактора висели под пустыми строками-заголовками, а «Информация о
// сети» открывалась значком 24×24 в углу строки.
//
// Стало: группа с пятью портами и переключателем локальной сети, и по группе на
// каждый список — ровно как у списков в components/settings/advanced-settings.
// Все десять настроек на месте.
//
// ⚠️ Заголовки групп взяты из СУЩЕСТВУЮЩИХ ключей перевода: локали правит
// другой человек, новых ключей здесь не появляется. Поэтому заголовок группы —
// это ровно та подпись, которая раньше стояла над списком.
//
// ⚠️ Кнопок «Подтвердить» рядом с полем больше нет (решение владельца
// 02.10.2026): все девять появлялись только при изменении значения. Порт
// применяется по уходу из поля и по Enter (FieldRow), списки — с паузой после
// набора (useDeferredCommit ниже).

/** Пауза в наборе, после которой список записывается в конфиг, мс. */
const LIST_COMMIT_MS = 600

// Отложенная запись списка. Копия заготовки из
// components/settings/advanced-settings.tsx — правя её там, правь и здесь.
//
// ⚠️ Без неё правка уходила в ядро на КАЖДЫЙ символ: EditableList зовёт
// onChange на каждое нажатие, а здесь следом ещё и перезагружается
// конфигурация ядра — недописанный диапазон вроде «192.168.» успевал бы
// уехать в ядро. Раньше от этого спасала кнопка «Подтвердить», но кнопок рядом
// с полем у нас больше нет, и паузу надо держать здесь. У каждого списка свой
// таймер: один на четверых отменял бы чужую правку.
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

// Ключи портов в конфиге ядра. HTTP-порт там зовётся просто port.
type PortKey = 'mixed-port' | 'socks-port' | 'port' | 'redir-port' | 'tproxy-port'

const PortSetting: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig } = useAppConfig()
  const { sysProxy, proxyMode = false, onlyActiveDevice = false } = appConfig || {}
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const {
    authentication = [],
    'skip-auth-prefixes': skipAuthPrefixes = ['127.0.0.1/32'],
    'allow-lan': allowLan,
    'lan-allowed-ips': lanAllowedIps = [],
    'lan-disallowed-ips': lanDisallowedIps = [],
    'mixed-port': mixedPort = 7897,
    'socks-port': socksPort = 0,
    port: httpPort = 0,
    'redir-port': redirPort = 0,
    'tproxy-port': tproxyPort = 0
  } = controledMihomoConfig || {}

  // Черновики списков. Они нужны не для кнопки, а для самого редактора: правка
  // уходит в главный процесс и возвращается через SWR, и список, показанный
  // прямо из конфига, терял бы символы при быстром наборе.
  const [lanAllowedIpsInput, setLanAllowedIpsInput] = useState(lanAllowedIps)
  const [lanDisallowedIpsInput, setLanDisallowedIpsInput] = useState(lanDisallowedIps)
  const [authenticationInput, setAuthenticationInput] = useState(authentication)
  const [skipAuthPrefixesInput, setSkipAuthPrefixesInput] = useState(skipAuthPrefixes)
  const [lanOpen, setLanOpen] = useState(false)
  // ⚠️ Счётчик снимает отвергнутую правку порта — см. commitPort ниже. Смена
  // key пересобирает строку, и её черновик снова берётся из конфига.
  const [portRevision, setPortRevision] = useState(0)

  const commitAllowedIps = useDeferredCommit()
  const commitDisallowedIps = useDeferredCommit()
  const commitAuthentication = useDeferredCommit()
  const commitSkipAuthPrefixes = useDeferredCommit()

  const parseAuth = (item: string): { part1: string; part2: string } => {
    const [user = '', pass = ''] = item.split(':')
    return { part1: user, part2: pass }
  }
  const formatAuth = (user: string, pass?: string): string => `${user}:${pass || ''}`

  const ports: Record<PortKey, number> = {
    'mixed-port': mixedPort,
    'socks-port': socksPort,
    port: httpPort,
    'redir-port': redirPort,
    'tproxy-port': tproxyPort
  }

  const onChangeNeedRestart = async (patch: Partial<MihomoConfig>): Promise<void> => {
    await patchControledMihomoConfig(patch)
    await mihomoHotReloadConfig()
  }

  const commitPort = async (key: PortKey, raw: string): Promise<void> => {
    // Границы были у самого поля (min=0, max=65535).
    let num = parseInt(raw)
    if (isNaN(num) || num < 0) num = 0
    if (num > 65535) num = 65535
    if (num === ports[key]) return

    // ⚠️ Столкновение портов. Раньше его ловила кнопка «Подтвердить»: пока два
    // порта совпадали, она была погашена сразу у всех пяти полей. Кнопок нет,
    // поэтому занятый порт просто не применяется, а поле возвращается к
    // сохранённому значению — иначе на экране остался бы порт, которого в ядре
    // нет. Ноль значит «порт выключен» и столкновением не считается.
    const taken = (Object.keys(ports) as PortKey[]).filter((k) => k !== key).map((k) => ports[k])
    if (num !== 0 && taken.includes(num)) {
      setPortRevision((n) => n + 1)
      return
    }

    await onChangeNeedRestart({ [key]: num } as Partial<MihomoConfig>)
    // Системный прокси указывает на смешанный порт: без перезаписи он остался
    // бы на старом. Остальные порты его не касаются.
    if (key === 'mixed-port' && proxyMode && sysProxy?.enable) {
      await triggerSysProxy(true, onlyActiveDevice)
    }
  }

  return (
    <>
      {lanOpen && <InterfaceModal onClose={() => setLanOpen(false)} />}

      <Group title={t('mihomo.portSettings.title')}>
        <FieldRow
          key={`mixed-port-${portRevision}`}
          icon={Route}
          label={t('mihomo.portSettings.mixedPort')}
          value={mixedPort.toString()}
          width={72}
          inputMode="numeric"
          onCommit={(next) => commitPort('mixed-port', next)}
        />
        <FieldRow
          key={`socks-port-${portRevision}`}
          icon={Unplug}
          label={t('mihomo.portSettings.socksPort')}
          value={socksPort.toString()}
          width={72}
          inputMode="numeric"
          onCommit={(next) => commitPort('socks-port', next)}
        />
        <FieldRow
          key={`http-port-${portRevision}`}
          icon={Globe}
          label={t('mihomo.portSettings.httpPort')}
          value={httpPort.toString()}
          width={72}
          inputMode="numeric"
          onCommit={(next) => commitPort('port', next)}
        />
        {platform !== 'win32' && (
          <FieldRow
            key={`redir-port-${portRevision}`}
            icon={Zap}
            label={t('mihomo.portSettings.redirPort')}
            value={redirPort.toString()}
            width={72}
            inputMode="numeric"
            onCommit={(next) => commitPort('redir-port', next)}
          />
        )}
        {platform === 'linux' && (
          <FieldRow
            key={`tproxy-port-${portRevision}`}
            icon={Gauge}
            label={t('mihomo.portSettings.tproxyPort')}
            value={tproxyPort.toString()}
            width={72}
            inputMode="numeric"
            onCommit={(next) => commitPort('tproxy-port', next)}
          />
        )}
        {/* «Информация о сети» раньше открывалась значком 24×24 в углу строки:
            что он покажет, можно было узнать только нажав. Теперь это кнопка
            строки с переключателем — с именем из того же ключа перевода. */}
        <SwitchRow
          icon={MonitorSmartphone}
          label={t('mihomo.portSettings.allowLan')}
          checked={allowLan ?? false}
          onCheckedChange={(v) => {
            onChangeNeedRestart({ 'allow-lan': v })
          }}
          action={{
            icon: Network,
            label: t('mihomo.interfaceModal.title'),
            onClick: () => setLanOpen(true)
          }}
        />
      </Group>

      {allowLan && (
        <>
          <Group title={t('mihomo.portSettings.allowedIpRanges')}>
            <div className="px-3 py-2">
              <EditableList
                items={lanAllowedIpsInput}
                divider={false}
                placeholder={t('mihomo.portSettings.ipRangePlaceholder')}
                onChange={(items) => {
                  const next = items as string[]
                  setLanAllowedIpsInput(next)
                  commitAllowedIps(() => onChangeNeedRestart({ 'lan-allowed-ips': next }))
                }}
              />
            </div>
          </Group>

          <Group title={t('mihomo.portSettings.deniedIpRanges')}>
            <div className="px-3 py-2">
              <EditableList
                items={lanDisallowedIpsInput}
                divider={false}
                placeholder={t('mihomo.portSettings.ipRangePlaceholder')}
                onChange={(items) => {
                  const next = items as string[]
                  setLanDisallowedIpsInput(next)
                  commitDisallowedIps(() => onChangeNeedRestart({ 'lan-disallowed-ips': next }))
                }}
              />
            </div>
          </Group>
        </>
      )}

      <Group title={t('mihomo.portSettings.authentication')}>
        <div className="px-3 py-2">
          <EditableList
            items={authenticationInput}
            divider={false}
            placeholder={t('mihomo.portSettings.usernamePlaceholder')}
            part2Placeholder={t('mihomo.portSettings.passwordPlaceholder')}
            parse={parseAuth}
            format={formatAuth}
            onChange={(items) => {
              const next = items as string[]
              setAuthenticationInput(next)
              commitAuthentication(() => onChangeNeedRestart({ authentication: next }))
            }}
          />
        </div>
      </Group>

      <Group title={t('mihomo.portSettings.skipAuthIpRanges')}>
        <div className="px-3 py-2">
          <EditableList
            items={skipAuthPrefixesInput}
            divider={false}
            disableFirst
            placeholder={t('mihomo.portSettings.ipRangePlaceholder')}
            onChange={(items) => {
              const next = items as string[]
              setSkipAuthPrefixesInput(next)
              commitSkipAuthPrefixes(() => onChangeNeedRestart({ 'skip-auth-prefixes': next }))
            }}
          />
        </div>
      </Group>
    </>
  )
}

export default PortSetting
