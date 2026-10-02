import React, { useState } from 'react'
import { FileText, MonitorCog, Route } from 'lucide-react'
import { Group, SwitchRow } from '@renderer/components/shell/list-group'
import EditableList from '../base/base-list-editor'
import { isValidDnsServer, isValidDomainWildcard } from '@renderer/utils/validate'
import { useTranslation } from 'react-i18next'

// Дополнительные настройки DNS на общем наборе строк
// (components/shell/list-group). Было: одна карточка старого вида, где три
// переключателя и четыре списка-редактора лежали в одной куче — у списков свои
// заголовки кеглем крупнее подписей соседних строк.
//
// Стало: переключатели — строки набора, каждый список — своя группа с
// заголовком из ТОГО ЖЕ ключа перевода, которым список был подписан раньше.
// Новых ключей здесь нет: локали правит другой человек.
//
// ⚠️ Группа с системным и своим hosts идёт без заголовка: подходящего ключа на
// неё нет, а заводить новый нельзя. Свой hosts остаётся сразу под своим
// переключателем — порядок строк тот же, что был.
//
// ⚠️ Отступов по краям компонент не добавляет: обёртку (px-4 pt-1) ставит
// страница, иначе на экране DNS появился бы двойной отступ.
interface AdvancedDnsSettingProps {
  respectRules: boolean
  directNameserver: string[]
  proxyServerNameserver: string[]
  nameserverPolicy: Record<string, string | string[]>
  hosts?: IHost[]
  useHosts: boolean
  useSystemHosts: boolean
  onRespectRulesChange: (v: boolean) => void
  onDirectNameserverChange: (list: string[]) => void
  onProxyNameserverChange: (list: string[]) => void
  onNameserverPolicyChange: (policy: Record<string, string | string[]>) => void
  onUseSystemHostsChange: (v: boolean) => void
  onUseHostsChange: (v: boolean) => void
  onHostsChange: (hosts: IHost[]) => void
  onErrorChange?: (hasError: boolean) => void
}

const AdvancedDnsSetting: React.FC<AdvancedDnsSettingProps> = ({
  respectRules,
  directNameserver,
  proxyServerNameserver,
  nameserverPolicy,
  hosts,
  useHosts,
  useSystemHosts,
  onRespectRulesChange,
  onDirectNameserverChange,
  onProxyNameserverChange,
  onNameserverPolicyChange,
  onUseSystemHostsChange,
  onUseHostsChange,
  onHostsChange,
  onErrorChange
}) => {
  const { t } = useTranslation()
  const [directNameserverError, setDirectNameserverError] = useState<string | null>(null)
  const [proxyNameserverError, setProxyNameserverError] = useState<string | null>(null)
  const [nameserverPolicyError, setNameserverPolicyError] = useState<string | null>(null)
  const [hostsError, setHostsError] = useState<string | null>(null)

  React.useEffect(() => {
    const hasError = Boolean(
      directNameserverError || proxyNameserverError || nameserverPolicyError || hostsError
    )
    onErrorChange?.(hasError)
  }, [
    directNameserverError,
    proxyNameserverError,
    nameserverPolicyError,
    hostsError,
    onErrorChange
  ])

  return (
    <>
      <Group title={t('dns.moreSettings')}>
        <SwitchRow
          icon={Route}
          label={t('dns.connectionRespectRules')}
          checked={respectRules}
          disabled={proxyServerNameserver.length === 0}
          onCheckedChange={onRespectRulesChange}
        />
      </Group>

      <Group title={t('dns.directResolver')}>
        <div className="px-3 py-2">
          <EditableList
            items={directNameserver}
            validate={(part) => isValidDnsServer(part as string)}
            onChange={(list) => {
              const arr = list as string[]
              onDirectNameserverChange(arr)
              const firstInvalid = arr.find((f) => !isValidDnsServer(f).ok)
              setDirectNameserverError(
                firstInvalid ? (isValidDnsServer(firstInvalid).error ?? t('common.formatError')) : null
              )
            }}
            placeholder={t('pages.dns.placeholderTLS')}
            divider={false}
          />
        </div>
      </Group>

      <Group title={t('dns.proxyNodeResolver')}>
        <div className="px-3 py-2">
          <EditableList
            items={proxyServerNameserver}
            validate={(part) => isValidDnsServer(part as string)}
            onChange={(list) => {
              const arr = list as string[]
              onProxyNameserverChange(arr)
              const firstInvalid = arr.find((f) => !isValidDnsServer(f).ok)
              setProxyNameserverError(
                firstInvalid ? (isValidDnsServer(firstInvalid).error ?? t('common.formatError')) : null
              )
            }}
            placeholder={t('pages.dns.placeholderTLS')}
            divider={false}
          />
        </div>
      </Group>

      <Group title={t('dns.domainResolutionPolicy')}>
        <div className="px-3 py-2">
          <EditableList
            items={nameserverPolicy}
            validatePart1={(part1) => isValidDomainWildcard(part1)}
            validatePart2={(part2) => {
              const parts = part2
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean)
              for (const p of parts) {
                const result = isValidDnsServer(p)
                if (!result.ok) {
                  return result
                }
              }
              return { ok: true }
            }}
            onChange={(newValue) => {
              onNameserverPolicyChange(newValue as Record<string, string | string[]>)
              try {
                const rec = newValue as Record<string, string | string[]>
                for (const domain of Object.keys(rec)) {
                  if (!isValidDomainWildcard(domain).ok) {
                    setNameserverPolicyError(
                      isValidDomainWildcard(domain).error ?? t('dns.domainFormatError')
                    )
                    return
                  }
                }
                for (const v of Object.values(rec)) {
                  if (Array.isArray(v)) {
                    for (const vv of v) {
                      if (!isValidDnsServer(vv).ok) {
                        setNameserverPolicyError(
                          isValidDnsServer(vv).error ?? t('common.formatError')
                        )
                        return
                      }
                    }
                  } else {
                    const parts = (v as string)
                      .split(',')
                      .map((p) => p.trim())
                      .filter(Boolean)
                    for (const p of parts) {
                      if (!isValidDnsServer(p).ok) {
                        setNameserverPolicyError(
                          isValidDnsServer(p).error ?? t('common.formatError')
                        )
                        return
                      }
                    }
                  }
                }
                setNameserverPolicyError(null)
              } catch (e) {
                setNameserverPolicyError(t('dns.policyFormatError'))
              }
            }}
            placeholder={t('dns.domain')}
            part2Placeholder={t('dns.dnsServerCommaSeparated')}
            objectMode="record"
            divider={false}
          />
        </div>
      </Group>

      <Group>
        <SwitchRow
          icon={MonitorCog}
          label={t('dns.useSystemHosts')}
          checked={useSystemHosts}
          onCheckedChange={onUseSystemHostsChange}
        />
        <SwitchRow
          icon={FileText}
          label={t('dns.customHosts')}
          checked={useHosts}
          onCheckedChange={onUseHostsChange}
        />
      </Group>

      {useHosts && (
        <Group title={t('dns.customHosts')}>
          <div className="px-3 py-2">
            <EditableList
              items={hosts ? Object.fromEntries(hosts.map((h) => [h.domain, h.value])) : {}}
              validatePart1={(part1) => isValidDomainWildcard(part1)}
              onChange={(rec) => {
                const hostArr: IHost[] = Object.entries(rec as Record<string, string | string[]>).map(
                  ([domain, value]) => ({
                    domain,
                    value: value as string | string[]
                  })
                )
                onHostsChange(hostArr)
                for (const domain of Object.keys(rec as Record<string, string | string[]>)) {
                  if (!isValidDomainWildcard(domain).ok) {
                    setHostsError(isValidDomainWildcard(domain).error ?? t('dns.domainFormatError'))
                    return
                  }
                }
                setHostsError(null)
              }}
              placeholder={t('dns.domain')}
              part2Placeholder={t('dns.domainOrIPCommaSeparated')}
              objectMode="record"
              divider={false}
            />
          </div>
        </Group>
      )}
    </>
  )
}

export default AdvancedDnsSetting
