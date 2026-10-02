import React from 'react'
import { useTranslation } from 'react-i18next'
import BasePage from '@renderer/components/base/base-page'
import { hiddenSettingsUnlocked } from '@renderer/utils/hidden-settings'
import AdvancedSettings from '@renderer/components/settings/advanced-settings'

// Раздел настроек отдельной страницей. Раньше это был свёрнутый аккордеон
// внутри общего экрана: три таких раздела прятали 47 строк, и о половине
// настроек нельзя было узнать, не раскрыв их наугад. Решение владельца
// 02.10.2026 — вариант «как в системных настройках».
const SettingsSection: React.FC = () => {
  const { t } = useTranslation()
  return (
    <BasePage title={t('settings.advanced.title')}>
      <div className="px-4 pt-1">
        <AdvancedSettings showHiddenSettings={hiddenSettingsUnlocked()} />
      </div>
    </BasePage>
  )
}

export default SettingsSection
