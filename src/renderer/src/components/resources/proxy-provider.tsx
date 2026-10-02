import {
  mihomoProxyProviders,
  mihomoUpdateProxyProviders,
  getRuntimeConfig
} from '@renderer/utils/ipc'
import { subscribeCoreStarted } from '@renderer/store/core-lifecycle-store'
import { useTranslation } from 'react-i18next'
import { Fragment, useEffect, useMemo, useState } from 'react'
import Viewer from './viewer'
import useSWR from 'swr'
import { Group, Row } from '@renderer/components/shell/list-group'
import dayjs from 'dayjs'
import { calcTraffic } from '@renderer/utils/calc'
import { getHash } from '@renderer/utils/hash'
import { FilePenLine, FileText, RefreshCcw } from 'lucide-react'

// Провайдеры прокси на общем наборе строк (components/shell/list-group).
// Разложены так же, как провайдеры правил (rule-provider.tsx): строка самого
// провайдера с нажатием «посмотреть/править», под ней строка «Обновить» со
// спиннером. Два безымянных значка 24×24 в правом углу строки ушли.
//
// ⚠️ Строка с трафиком подписки — НЕ Row: Row — это кнопка, а трафик и срок
// читают, а не нажимают, и фокусируемая строка без действия обманывает мышь и
// клавиатуру. Геометрию строки набора повторяем вручную — так же сделано в
// карточке устройства (components/cabinet/device-sheet.tsx:432).
//
// ⚠️ Трафик оставлен отдельной строкой, а не дописан в подпись провайдера: при
// минимальной ширине окна (420px) подпись обрезается, и «12 ГБ / 100 ГБ» с
// датой окончания просто исчезали бы из виду.
//
// ⚠️ Заголовок группы — существующий ключ resources.proxyProvider: новых
// ключей перевода здесь не появляется.
const ProxyProvider: React.FC = () => {
  const { t } = useTranslation()
  const [showDetails, setShowDetails] = useState({
    show: false,
    path: '',
    type: '',
    title: '',
    privderType: ''
  })
  useEffect(() => {
    if (showDetails.title) {
      const fetchProviderPath = async (name: string): Promise<void> => {
        try {
          const providers = await getRuntimeConfig()
          const provider = providers?.['proxy-providers']?.[name] as ProxyProviderConfig
          if (provider) {
            setShowDetails((prev) => ({
              ...prev,
              show: true,
              path: provider.path || `proxies/${getHash(provider.url || '')}`
            }))
          }
        } catch {
          setShowDetails((prev) => ({ ...prev, path: '' }))
        }
      }
      fetchProviderPath(showDetails.title)
    }
  }, [showDetails.title])

  const { data, mutate } = useSWR('mihomoProxyProviders', mihomoProxyProviders, {
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
    return Object.values(data.providers)
      .filter((provider) => provider.vehicleType !== 'Compatible')
      .sort((a, b) => {
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
      await mihomoUpdateProxyProviders(name)
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
          privderType={showDetails.privderType}
          onClose={() =>
            setShowDetails({ show: false, path: '', type: '', title: '', privderType: '' })
          }
        />
      )}
      <Group title={t('resources.proxyProvider')}>
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
              // Сколько узлов и откуда они берутся — раньше это были плашка у
              // имени и строка ниже.
              sub={[provider.proxies?.length || 0, provider.vehicleType].join(' · ')}
              value={dayjs(provider.updatedAt).fromNow()}
              trailing="chevron"
              title={provider.vehicleType == 'File' ? t('resources.edit') : t('resources.view')}
              onClick={() => {
                setShowDetails({
                  show: false,
                  privderType: 'proxy-providers',
                  path: provider.name,
                  type: provider.vehicleType,
                  title: provider.name
                })
              }}
            />
            {provider.subscriptionInfo && (
              <div className="flex min-h-10 items-center gap-2.5 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {`${calcTraffic(
                    provider.subscriptionInfo.Upload + provider.subscriptionInfo.Download
                  )} / ${calcTraffic(provider.subscriptionInfo.Total)}`}
                </span>
                <span className="max-w-[55%] shrink-0 truncate text-sm text-muted-foreground">
                  {provider.subscriptionInfo.Expire
                    ? dayjs.unix(provider.subscriptionInfo.Expire).format('YYYY-MM-DD')
                    : t('profile.longTermValid')}
                </span>
              </div>
            )}
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

export default ProxyProvider
