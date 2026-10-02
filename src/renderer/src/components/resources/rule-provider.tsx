import {
  mihomoRuleProviders,
  mihomoUpdateRuleProviders,
  getRuntimeConfig
} from '@renderer/utils/ipc'
import { subscribeCoreStarted } from '@renderer/store/core-lifecycle-store'
import { getHash } from '@renderer/utils/hash'
import Viewer from './viewer'
import { Fragment, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { Group, Row } from '@renderer/components/shell/list-group'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import { FilePenLine, FileText, RefreshCcw } from 'lucide-react'

// Провайдеры правил на общем наборе строк (components/shell/list-group).
//
// Было: карточка старого вида, где на каждого провайдера приходилось две
// строки, а в правый угол первой были сложены срок давности, значок
// «посмотреть/править» и значок «обновить» — два значка 24×24 без подписей,
// угадываемые только наведением.
//
// Стало: у провайдера по-прежнему две строки, но обе с именами. Первая —
// сам провайдер: нажатие открывает содержимое (для File — на правку, для
// остального — на чтение, ровно как решал старый значок), справа срок
// давности, во второй строке подписи число правил, формат и источник с
// поведением. Вторая — «Обновить» этого провайдера, со спиннером в строке.
//
// ⚠️ Заголовок группы взят из существующего ключа resources.ruleProvider:
// новых ключей перевода здесь не появляется, локали правит другой человек.
const RuleProvider: React.FC = () => {
  const { t } = useTranslation()
  const [showDetails, setShowDetails] = useState({
    show: false,
    path: '',
    type: '',
    title: '',
    format: '',
    privderType: '',
    behavior: ''
  })
  useEffect(() => {
    if (showDetails.title) {
      const fetchProviderPath = async (name: string): Promise<void> => {
        try {
          const providers = await getRuntimeConfig()
          const provider = providers['rule-providers']?.[name]
          if (provider) {
            setShowDetails((prev) => ({
              ...prev,
              show: true,
              path: provider?.path || `rules/${getHash(provider?.url)}`,
              behavior: provider?.behavior || 'domain'
            }))
          }
        } catch {
          setShowDetails((prev) => ({ ...prev, path: '', behavior: '' }))
        }
      }
      fetchProviderPath(showDetails.title)
    }
  }, [showDetails.title])

  const { data, mutate } = useSWR('mihomoRuleProviders', mihomoRuleProviders, {
    errorRetryInterval: 200,
    errorRetryCount: 10
  })

  useEffect(() => {
    return subscribeCoreStarted(() => {
      mutate()
    })
  }, [mutate])

  const providers = useMemo(() => {
    if (!data) return []
    return Object.values(data.providers).sort((a, b) => {
      const order = { File: 1, Inline: 2, HTTP: 3 }
      return (order[a.vehicleType] || 4) - (order[b.vehicleType] || 4)
    })
  }, [data])
  const [updating, setUpdating] = useState(Array(providers.length).fill(false))

  const onUpdate = async (name: string, index: number): Promise<void> => {
    setUpdating((prev) => {
      prev[index] = true
      return [...prev]
    })
    try {
      await mihomoUpdateRuleProviders(name)
      mutate()
    } catch (e) {
      new Notification(t('resources.updateFailed', { name, error: String(e) }))
    } finally {
      setUpdating((prev) => {
        prev[index] = false
        return [...prev]
      })
    }
  }

  if (!providers.length) {
    return null
  }

  return (
    <>
      {showDetails.show && (
        <Viewer
          path={showDetails.path}
          type={showDetails.type}
          title={showDetails.title}
          format={showDetails.format}
          privderType={showDetails.privderType}
          behavior={showDetails.behavior}
          onClose={() =>
            setShowDetails({
              show: false,
              path: '',
              type: '',
              title: '',
              format: '',
              privderType: '',
              behavior: ''
            })
          }
        />
      )}
      <Group title={t('resources.ruleProvider')}>
        <Row
          icon={RefreshCcw}
          label={t('resources.updateAll')}
          trailing="chevron"
          onClick={() => {
            providers.forEach((provider, index) => {
              onUpdate(provider.name, index)
            })
          }}
        />
        {providers.map((provider, index) => (
          <Fragment key={provider.name}>
            <Row
              icon={provider.vehicleType == 'File' ? FilePenLine : FileText}
              label={provider.name}
              // Три факта о провайдере, которые раньше занимали отдельную
              // строку и плашку у имени: сколько правил, в каком формате,
              // откуда и с каким поведением.
              sub={[
                provider.ruleCount,
                provider.format || 'InlineRule',
                `${provider.vehicleType}::${provider.behavior || ''}`
              ].join(' · ')}
              value={dayjs(provider.updatedAt).fromNow()}
              trailing="chevron"
              title={provider.vehicleType == 'File' ? t('resources.edit') : t('resources.view')}
              onClick={() => {
                setShowDetails({
                  show: false,
                  privderType: 'rule-providers',
                  path: provider.name,
                  type: provider.vehicleType,
                  title: provider.name,
                  format: provider.format,
                  behavior: provider.behavior || 'domain'
                })
              }}
            />
            <Row
              icon={RefreshCcw}
              label={t('common.update')}
              busy={updating[index]}
              trailing="chevron"
              onClick={() => {
                onUpdate(provider.name, index)
              }}
            />
          </Fragment>
        ))}
      </Group>
    </>
  )
}

export default RuleProvider
