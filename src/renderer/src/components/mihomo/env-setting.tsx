import React, { useState } from 'react'
import { toast } from 'sonner'
import PubSub from 'pubsub-js'
import { useTranslation } from 'react-i18next'
import { FileText, Route, Shield, Table2 } from 'lucide-react'
import { Group, SwitchRow } from '@renderer/components/shell/list-group'
import EditableList from '../base/base-list-editor'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { restartCore } from '@renderer/utils/ipc'
import { platform } from '@renderer/utils/init'

// Переменные окружения ядра на общем наборе строк (shell/list-group).
//
// Было: одна карточка из пяти строк старого вида — четыре переключателя и
// список доверенных путей с кнопкой «Подтвердить». Стало: две группы со
// строками того же вида, что на остальных экранах. Все пять настроек на месте.
//
// ⚠️ Заголовки групп взяты из СУЩЕСТВУЮЩИХ ключей перевода: локали правит
// другой человек, новых ключей здесь не появляется. Поэтому вторая группа
// называется ровно так, как раньше называлась её строка — «Доверенный путь»
// (mihomo.envSettings.trustedPath).

const EnvSetting: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    disableLoopbackDetector,
    disableEmbedCA,
    disableSystemCA,
    disableNftables,
    safePaths = []
  } = appConfig || {}
  const handleConfigChangeWithRestart = async (key: string, value: unknown): Promise<void> => {
    try {
      await patchAppConfig({ [key]: value })
      await restartCore()
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      PubSub.publish('mihomo-core-changed')
    }
  }

  // Черновик списка нужен не для кнопки, а для самого редактора: patchAppConfig
  // уходит в главный процесс и возвращается через SWR, и список, показанный
  // прямо из конфига, терял бы символы при быстром наборе.
  const [safePathsInput, setSafePathsInput] = useState(safePaths)

  return (
    <>
      <Group title={t('mihomo.envSettings.environmentVariables')}>
        <SwitchRow
          icon={Shield}
          label={t('mihomo.envSettings.disableSystemCA')}
          checked={disableSystemCA ?? false}
          onCheckedChange={(v) => {
            handleConfigChangeWithRestart('disableSystemCA', v)
          }}
        />
        <SwitchRow
          icon={FileText}
          label={t('mihomo.envSettings.disableBuiltinCA')}
          checked={disableEmbedCA ?? false}
          onCheckedChange={(v) => {
            handleConfigChangeWithRestart('disableEmbedCA', v)
          }}
        />
        <SwitchRow
          icon={Route}
          label={t('mihomo.envSettings.disableLoopbackDetection')}
          checked={disableLoopbackDetector ?? false}
          onCheckedChange={(v) => {
            handleConfigChangeWithRestart('disableLoopbackDetector', v)
          }}
        />
        {platform == 'linux' && (
          <SwitchRow
            icon={Table2}
            label={t('mihomo.envSettings.disableNftables')}
            checked={disableNftables ?? false}
            onCheckedChange={(v) => {
              handleConfigChangeWithRestart('disableNftables', v)
            }}
          />
        )}
      </Group>

      <Group title={t('mihomo.envSettings.trustedPath')}>
        {/* ⚠️ Список записывается по уходу фокуса ИЗ ВСЕГО редактора, а не по
            паузе в наборе. Запись здесь — это patchAppConfig плюс ПЕРЕЗАПУСК
            ЯДРА: путь уезжает в ядро переменной окружения SAFE_PATHS при
            запуске, горячей перезагрузкой его не доставить. С паузой в 600мс
            человек, набирающий «/Applications/Telegram.app» с остановками,
            ронял бы все соединения по нескольку раз за один путь, да ещё и
            записывал бы в конфиг обрезанные куски. Перезапуск нужен — лишним
            было то, что его звало. */}
        <div
          className="px-3 py-2"
          onBlur={(e) => {
            // Переход между полями внутри самого редактора уходом не считаем.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            if (safePathsInput.join('\u0000') === (safePaths ?? []).join('\u0000')) return
            void handleConfigChangeWithRestart('safePaths', safePathsInput)
          }}
        >
          <EditableList
            items={safePathsInput}
            divider={false}
            onChange={(list) => setSafePathsInput(list as string[])}
          />
        </div>
      </Group>
    </>
  )
}

export default EnvSetting
