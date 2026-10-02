import BasePage from '@renderer/components/base/base-page'
import GeoData from '@renderer/components/resources/geo-data'
import ProxyProvider from '@renderer/components/resources/proxy-provider'
import RuleProvider from '@renderer/components/resources/rule-provider'
import { useTranslation } from 'react-i18next'

// Внешние ресурсы: Geo-базы и два списка провайдеров. Отступы ставит страница —
// внутри разделов их нет, иначе группы разъехались бы с настройками.
const Resources: React.FC = () => {
  const { t } = useTranslation()
  return (
    <BasePage title={t('pages.resources.title')}>
      <div className="px-4 pt-1">
        <GeoData />
        <ProxyProvider />
        <RuleProvider />
      </div>
    </BasePage>
  )
}

export default Resources
