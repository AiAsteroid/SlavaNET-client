import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  Database,
  Fingerprint,
  Gauge,
  Globe,
  Network,
  Search,
  Timer,
  Unplug,
  Zap
} from 'lucide-react'
import {
  FieldRow,
  Group,
  SegmentRow,
  SelectRow,
  SwitchRow
} from '@renderer/components/shell/list-group'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { getInterfaces } from '@renderer/utils/ipc'

// Расширенные настройки ядра на общем наборе строк (shell/list-group).
//
// Было: одна карточка из десяти строк старого вида — вкладки, два поля с
// кнопкой «Подтвердить», селект на десять значений и выбор интерфейса,
// сложенные подряд без заголовков. Два пояснения прятались под
// вопросиками-подсказками.
//
// Стало: три группы по смыслу, и все десять настроек на месте — поиск процесса
// и кеш (3), TCP-соединение (5), отпечаток и исходящий интерфейс (2).
//
// ⚠️ Подсказок-вопросиков больше нет: текст unifiedDelayTip и tcpConcurrentTip
// переехал во вторую строку самой настройки. Ключи перевода те же — локали
// правит другой человек, новых ключей здесь не появляется.
//
// ⚠️ Кнопок «Подтвердить» у полей больше нет (решение владельца 02.10.2026):
// обе появлялись только при изменении значения. Поле применяет правку по уходу
// и по Enter (FieldRow).
//
// ⚠️ Заголовок третьей группы отсутствует намеренно: подходящего ключа
// перевода на «Транспорт» в локалях нет, а заводить новый нельзя.

// Отдельного значения «выключено» у отпечатка нет — в конфиге это пустая
// строка, а пустое значение в выпадающем списке неотличимо от «не выбрано».
const NONE = '__none__'

const AdvancedSetting: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const {
    'unified-delay': unifiedDelay,
    'tcp-concurrent': tcpConcurrent,
    'disable-keep-alive': disableKeepAlive = false,
    'find-process-mode': findProcessMode = 'always',
    'interface-name': interfaceName = '',
    'global-client-fingerprint': globalClientFingerprint = '',
    'keep-alive-idle': idle = 15,
    'keep-alive-interval': interval = 15,
    profile = {},
    tun = {}
  } = controledMihomoConfig || {}
  const { 'store-selected': storeSelected, 'store-fake-ip': storeFakeIp } = profile
  const { device = 'mihomo' } = tun

  // ⚠️ Тип указан руками: иначе из пустой строки вывод сузился бы до варианта
  // БЕЗ неё, и список значений перестал бы сходиться со значением строки.
  const fingerprintValue: Fingerprints | typeof NONE = globalClientFingerprint || NONE

  // Список интерфейсов раньше приносил отдельный компонент InterfaceSelect со
  // своим селектом. Набор строк выбирает через SelectRow, поэтому список
  // запрашивается здесь: сам туннель и петля из него исключены — выпускать
  // трафик в них бессмысленно.
  const [interfaces, setInterfaces] = useState<string[]>([])
  useEffect(() => {
    getInterfaces()
      .then((info) => setInterfaces(Object.keys(info)))
      .catch(() => {})
  }, [])

  const onChangeNeedRestart = async (patch: Partial<MihomoConfig>): Promise<void> => {
    await patchControledMihomoConfig(patch)
  }

  const fingerprintOptions: { value: Fingerprints | typeof NONE; label: string }[] = [
    { value: NONE, label: t('mihomo.advancedSettings.disabled') },
    { value: 'random', label: t('mihomo.advancedSettings.random') },
    { value: 'chrome', label: 'Chrome' },
    { value: 'firefox', label: 'Firefox' },
    { value: 'safari', label: 'Safari' },
    { value: 'ios', label: 'iOS' },
    { value: 'android', label: 'Android' },
    { value: 'edge', label: 'Edge' },
    { value: '360', label: '360' },
    { value: 'qq', label: 'QQ' }
  ]

  const interfaceOptions = [
    { value: NONE, label: t('common.disabled') },
    ...interfaces
      .filter((name) => name !== device && name !== 'lo')
      .map((name) => ({ value: name, label: name }))
  ]

  return (
    <>
      <Group title={t('mihomo.advancedSettings.title')}>
        <SegmentRow
          icon={Search}
          label={t('mihomo.advancedSettings.findProcess')}
          value={findProcessMode}
          options={[
            { value: 'strict', label: t('mihomo.advancedSettings.auto') },
            { value: 'off', label: t('common.close') },
            { value: 'always', label: t('mihomo.advancedSettings.enable') }
          ]}
          onChange={(value) => {
            onChangeNeedRestart({ 'find-process-mode': value })
          }}
        />
        <SwitchRow
          icon={Database}
          label={t('mihomo.advancedSettings.storeSelected')}
          checked={storeSelected ?? false}
          onCheckedChange={(value) => {
            onChangeNeedRestart({ profile: { 'store-selected': value } })
          }}
        />
        <SwitchRow
          icon={Globe}
          label={t('mihomo.advancedSettings.storeFakeIP')}
          checked={storeFakeIp ?? false}
          onCheckedChange={(value) => {
            onChangeNeedRestart({ profile: { 'store-fake-ip': value } })
          }}
        />
      </Group>

      <Group title={t('pages.settings.groupConnection')}>
        <SwitchRow
          icon={Gauge}
          label={t('mihomo.advancedSettings.unifiedDelay')}
          sub={t('mihomo.advancedSettings.unifiedDelayTip')}
          checked={unifiedDelay ?? false}
          onCheckedChange={(value) => {
            onChangeNeedRestart({ 'unified-delay': value })
          }}
        />
        <SwitchRow
          icon={Zap}
          label={t('mihomo.advancedSettings.tcpConcurrent')}
          sub={t('mihomo.advancedSettings.tcpConcurrentTip')}
          checked={tcpConcurrent ?? false}
          onCheckedChange={(value) => {
            onChangeNeedRestart({ 'tcp-concurrent': value })
          }}
        />
        <SwitchRow
          icon={Unplug}
          label={t('mihomo.advancedSettings.disableTCPKeepAlive')}
          checked={disableKeepAlive}
          onCheckedChange={(value) => {
            onChangeNeedRestart({ 'disable-keep-alive': value })
          }}
        />
        {/* Единица измерения раньше нигде не стояла: поле с числом 15 ничего не
            говорило о секундах. Текст взят из существующего ключа. */}
        <FieldRow
          icon={Timer}
          label={`${t('mihomo.advancedSettings.tcpKeepAliveInterval')}, ${t('settings.advanced.seconds')}`}
          value={interval.toString()}
          width={72}
          inputMode="numeric"
          onCommit={async (next) => {
            // Минимум был у самого поля (min=0): отрицательный интервал ядро
            // не примет.
            let num = parseInt(next)
            if (isNaN(num) || num < 0) num = 0
            await onChangeNeedRestart({ 'keep-alive-interval': num })
          }}
        />
        <FieldRow
          icon={Clock}
          label={`${t('mihomo.advancedSettings.tcpKeepAliveIdle')}, ${t('settings.advanced.seconds')}`}
          value={idle.toString()}
          width={72}
          inputMode="numeric"
          onCommit={async (next) => {
            let num = parseInt(next)
            if (isNaN(num) || num < 0) num = 0
            await onChangeNeedRestart({ 'keep-alive-idle': num })
          }}
        />
      </Group>

      <Group>
        <SelectRow
          icon={Fingerprint}
          label={t('mihomo.advancedSettings.utlsFingerprint')}
          value={fingerprintValue}
          options={fingerprintOptions}
          onChange={(value) => {
            onChangeNeedRestart({
              'global-client-fingerprint': (value === NONE ? '' : value) as Fingerprints
            })
          }}
        />
        <SelectRow
          icon={Network}
          label={t('mihomo.advancedSettings.outboundInterface')}
          value={interfaceName || NONE}
          options={interfaceOptions}
          onChange={(value) => {
            onChangeNeedRestart({ 'interface-name': value === NONE ? '' : value })
          }}
        />
      </Group>
    </>
  )
}

export default AdvancedSetting
