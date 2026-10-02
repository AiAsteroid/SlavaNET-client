import { toast } from 'sonner'
import { Globe, Network, Route } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import BasePage from '@renderer/components/base/base-page'
import EditableList from '@renderer/components/base/base-list-editor'
import { FieldRow, Group, SegmentRow, SwitchRow } from '@renderer/components/shell/list-group'
import AdvancedDnsSetting from '@renderer/components/dns/advanced-dns-setting'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import React, { useState } from 'react'
import {
  isValidIPv4Cidr,
  isValidIPv6Cidr,
  isValidDomainWildcard,
  isValidDnsServer
} from '@renderer/utils/validate'
import { useTranslation } from 'react-i18next'

// Экран DNS на общем наборе строк (components/shell/list-group). Было: одна
// карточка старого вида на семь настроек, где переключатель, вкладки, два поля
// и три списка-редактора шли подряд без заголовков.
//
// ⚠️ Кнопка «Сохранить» в ШАПКЕ осталась: она не «подтвердить рядом с полем», а
// применение всего экрана сразу — ядро перечитывает конфиг целиком, и писать в
// него на каждый введённый символ нельзя. Поля (FieldRow) применяют правку в
// черновик по уходу и по Enter, а кнопка отправляет черновик ядру.
//
// ⚠️ Ошибка формата раньше показывалась всплывающей подсказкой у поля. Теперь
// она во второй строке самой настройки, красным: подсказка висела поверх
// соседней строки и исчезала при первом же движении мыши. Текст тот же, ключи
// перевода те же.
//
// ⚠️ Вторая строка в наборе однострочная и обрезается по ширине, а «Неверный
// формат CIDR (пример: 198.18.0.1/16)» в неё не влезает. Поэтому красная
// пометка у строки — признак «сюда смотреть», а полный текст уходит
// уведомлением, тем же способом, которым экран сообщает об остальных ошибках.
// Кнопка «Сохранить» в шапке при ошибке по-прежнему заблокирована.
//
// ⚠️ Списки-редакторы (EditableList) оставлены как есть — заголовок каждого
// переехал в заголовок его группы, из тех же ключей.
const DNS: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { hosts } = appConfig || {}
  const { dns } = controledMihomoConfig || {}
  const {
    ipv6 = false,
    'fake-ip-range': fakeIPRange = '198.18.0.1/16',
    'fake-ip-range6': fakeIPRange6 = '',
    'fake-ip-filter': fakeIPFilter = [
      '*',
      '+.lan',
      '+.local',
      'time.*.com',
      'ntp.*.com',
      '+.market.xiaomi.com'
    ],
    'enhanced-mode': enhancedMode = 'fake-ip',
    'use-hosts': useHosts = false,
    'use-system-hosts': useSystemHosts = false,
    'respect-rules': respectRules = false,
    'default-nameserver': defaultNameserver = ['tls://223.5.5.5'],
    nameserver = ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    'proxy-server-nameserver': proxyServerNameserver = [],
    'direct-nameserver': directNameserver = [],
    'nameserver-policy': nameserverPolicy = {}
  } = dns || {}
  const [changed, setChanged] = useState(false)
  const [values, originSetValues] = useState({
    ipv6,
    useHosts,
    enhancedMode,
    fakeIPRange,
    fakeIPRange6,
    fakeIPFilter,
    useSystemHosts,
    respectRules,
    defaultNameserver,
    nameserver,
    proxyServerNameserver,
    directNameserver,
    nameserverPolicy,
    hosts: useHosts ? hosts : undefined
  })
  const [fakeIPRangeError, setFakeIPRangeError] = useState<string | null>(() => {
    const r = isValidIPv4Cidr(fakeIPRange)
    return r.ok ? null : (r.error ?? t('common.formatError'))
  })
  const [fakeIPRange6Error, setFakeIPRange6Error] = useState<string | null>(() => {
    const r = isValidIPv6Cidr(fakeIPRange6)
    return r.ok ? null : (r.error ?? t('common.formatError'))
  })
  const [fakeIPFilterError, setFakeIPFilterError] = useState<string | null>(() => {
    if (!Array.isArray(fakeIPFilter)) return null
    const firstInvalid = fakeIPFilter.find((f) => !isValidDomainWildcard(f).ok)
    return firstInvalid ? (isValidDomainWildcard(firstInvalid).error ?? t('common.formatError')) : null
  })
  const [defaultNameserverError, setDefaultNameserverError] = useState<string | null>(() => {
    if (!Array.isArray(defaultNameserver)) return null
    const firstInvalid = defaultNameserver.find((f) => !isValidDnsServer(f, true).ok)
    return firstInvalid ? (isValidDnsServer(firstInvalid, true).error ?? t('common.formatError')) : null
  })
  const [nameserverError, setNameserverError] = useState<string | null>(() => {
    if (!Array.isArray(nameserver)) return null
    const firstInvalid = nameserver.find((f) => !isValidDnsServer(f).ok)
    return firstInvalid ? (isValidDnsServer(firstInvalid).error ?? t('common.formatError')) : null
  })
  const [advancedDnsError, setAdvancedDnsError] = useState(false)
  const hasDnsErrors = Boolean(defaultNameserverError || nameserverError || advancedDnsError)

  const setValues = (v: typeof values): void => {
    originSetValues(v)
    setChanged(true)
  }

  const onSave = async (patch: Partial<MihomoConfig>): Promise<void> => {
    await patchAppConfig({
      hosts: values.hosts
    })
    try {
      setChanged(false)
      await patchControledMihomoConfig(patch)
    } catch (e) {
      toast.error(`${e}`)
    }
  }

  return (
    <BasePage
      title={t('pages.dns.title')}
      header={
        changed && (
          <Button
            size="sm"
            className="app-nodrag"
            disabled={
              values && values.enhancedMode === 'fake-ip'
                ? Boolean(fakeIPRangeError) ||
                  (values.ipv6 && Boolean(fakeIPRange6Error)) ||
                  Boolean(fakeIPFilterError) ||
                  hasDnsErrors
                : hasDnsErrors
            }
            onClick={() => {
              const hostsObject =
                values.useHosts && values.hosts && values.hosts.length > 0
                  ? Object.fromEntries(values.hosts.map(({ domain, value }) => [domain, value]))
                  : undefined
              const dnsConfig = {
                ipv6: values.ipv6,
                'fake-ip-range': values.fakeIPRange,
                'fake-ip-range6': values.fakeIPRange6,
                'fake-ip-filter': values.fakeIPFilter,
                'enhanced-mode': values.enhancedMode,
                'use-hosts': values.useHosts,
                'use-system-hosts': values.useSystemHosts,
                'respect-rules': values.respectRules,
                'default-nameserver': values.defaultNameserver,
                nameserver: values.nameserver,
                'proxy-server-nameserver': values.proxyServerNameserver,
                'direct-nameserver': values.directNameserver,
                'nameserver-policy': values.nameserverPolicy
              }
              onSave({
                dns: dnsConfig,
                hosts: hostsObject
              })
            }}
          >
            {t('common.save')}
          </Button>
        )
      }
    >
      <div className="px-4 pt-1">
        <Group>
          <SwitchRow
            icon={Globe}
            label={t('pages.dns.ipv6')}
            checked={values.ipv6}
            onCheckedChange={(v) => {
              setValues({ ...values, ipv6: v })
            }}
          />
          <SegmentRow
            icon={Route}
            label={t('pages.dns.domainMappingMode')}
            value={values.enhancedMode}
            options={[
              { value: 'fake-ip', label: t('pages.dns.fakeIP') },
              { value: 'redir-host', label: t('pages.dns.realIP') },
              { value: 'normal', label: t('pages.dns.cancelMapping') }
            ]}
            onChange={(value) => setValues({ ...values, enhancedMode: value as DnsMode })}
          />
          {values.enhancedMode === 'fake-ip' && (
            <>
              <FieldRow
                icon={Network}
                label={t('pages.dns.fakeIPRangeIPv4')}
                sub={
                  fakeIPRangeError ? (
                    <span className="text-destructive">{fakeIPRangeError}</span>
                  ) : undefined
                }
                value={values.fakeIPRange}
                width={150}
                placeholder={t('pages.dns.placeholderExample') + ': 198.18.0.1/16'}
                onCommit={(next) => {
                  setValues({ ...values, fakeIPRange: next })
                  const r = isValidIPv4Cidr(next)
                  const error = r.ok ? null : (r.error ?? t('common.formatError'))
                  setFakeIPRangeError(error)
                  if (error) toast.error(error)
                }}
              />
              {values.ipv6 && (
                <FieldRow
                  icon={Network}
                  label={t('pages.dns.fakeIPRangeIPv6')}
                  sub={
                    fakeIPRange6Error ? (
                      <span className="text-destructive">{fakeIPRange6Error}</span>
                    ) : undefined
                  }
                  value={values.fakeIPRange6}
                  width={150}
                  placeholder={t('pages.dns.placeholderExample') + ': fc00::/18'}
                  onCommit={(next) => {
                    setValues({ ...values, fakeIPRange6: next })
                    const r = isValidIPv6Cidr(next)
                    const error = r.ok ? null : (r.error ?? t('common.formatError'))
                    setFakeIPRange6Error(error)
                    if (error) toast.error(error)
                  }}
                />
              )}
            </>
          )}
        </Group>

        {values.enhancedMode === 'fake-ip' && (
          <Group title={t('pages.dns.fakeIPFilter')}>
            <div className="px-3 py-2">
              <EditableList
                items={values.fakeIPFilter}
                validate={(part) => isValidDomainWildcard(part as string)}
                onChange={(list) => {
                  const arr = list as string[]
                  setValues({ ...values, fakeIPFilter: arr })
                  const firstInvalid = arr.find((f) => !isValidDomainWildcard(f).ok)
                  setFakeIPFilterError(
                    firstInvalid
                      ? (isValidDomainWildcard(firstInvalid).error ?? t('common.formatError'))
                      : null
                  )
                }}
                placeholder={t('pages.dns.placeholderLan')}
                divider={false}
              />
            </div>
          </Group>
        )}

        <Group title={t('pages.dns.baseServer')}>
          <div className="px-3 py-2">
            <EditableList
              items={values.defaultNameserver}
              validate={(part) => isValidDnsServer(part as string, true)}
              onChange={(list) => {
                const arr = list as string[]
                setValues({ ...values, defaultNameserver: arr })
                const firstInvalid = arr.find((f) => !isValidDnsServer(f, true).ok)
                setDefaultNameserverError(
                  firstInvalid
                    ? (isValidDnsServer(firstInvalid, true).error ?? t('common.formatError'))
                    : null
                )
              }}
              placeholder={t('pages.dns.placeholderDNS')}
              divider={false}
            />
          </div>
        </Group>

        <Group title={t('pages.dns.defaultResolver')}>
          <div className="px-3 py-2">
            <EditableList
              items={values.nameserver}
              validate={(part) => isValidDnsServer(part as string)}
              onChange={(list) => {
                const arr = list as string[]
                setValues({ ...values, nameserver: arr })
                const firstInvalid = arr.find((f) => !isValidDnsServer(f).ok)
                setNameserverError(
                  firstInvalid
                    ? (isValidDnsServer(firstInvalid).error ?? t('common.formatError'))
                    : null
                )
              }}
              placeholder={t('pages.dns.placeholderTLS')}
              divider={false}
            />
          </div>
        </Group>

        <AdvancedDnsSetting
          respectRules={values.respectRules}
          directNameserver={values.directNameserver}
          proxyServerNameserver={values.proxyServerNameserver}
          nameserverPolicy={values.nameserverPolicy}
          hosts={values.hosts}
          useHosts={values.useHosts}
          useSystemHosts={values.useSystemHosts}
          onRespectRulesChange={(v) => {
            setValues({
              ...values,
              respectRules: values.proxyServerNameserver.length === 0 ? false : v
            })
          }}
          onDirectNameserverChange={(arr) => {
            setValues({ ...values, directNameserver: arr })
          }}
          onProxyNameserverChange={(arr) => {
            setValues({
              ...values,
              proxyServerNameserver: arr,
              respectRules: arr.length === 0 ? false : values.respectRules
            })
          }}
          onNameserverPolicyChange={(newValue) => {
            setValues({ ...values, nameserverPolicy: newValue })
          }}
          onUseSystemHostsChange={(v) => setValues({ ...values, useSystemHosts: v })}
          onUseHostsChange={(v) => setValues({ ...values, useHosts: v })}
          onHostsChange={(hostArr) => setValues({ ...values, hosts: hostArr })}
          onErrorChange={setAdvancedDnsError}
        />
      </div>
    </BasePage>
  )
}

export default DNS
