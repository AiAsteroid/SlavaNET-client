import React, { useEffect, useRef, useState } from 'react'
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

/** Пауза в наборе, после которой список записывается в конфиг, мс. */
const LIST_COMMIT_MS = 600

// Отложенная запись списка. Копия заготовки из
// components/settings/advanced-settings.tsx — правя её там, правь и здесь.
//
// ⚠️ Без неё правка уходила в конфиг на КАЖДЫЙ символ: EditableList зовёт
// onChange на каждое нажатие, а здесь следом ещё и ПЕРЕЗАПУСКАЕТСЯ ЯДРО —
// недописанный путь ронял бы соединение на каждой букве. Раньше от этого
// спасала кнопка «Подтвердить», но кнопок рядом с полем у нас больше нет, и
// паузу надо держать здесь.
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
  const commitSafePaths = useDeferredCommit()

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
        <div className="px-3 py-2">
          <EditableList
            items={safePathsInput}
            divider={false}
            onChange={(list) => {
              const next = list as string[]
              setSafePathsInput(next)
              commitSafePaths(() => handleConfigChangeWithRestart('safePaths', next))
            }}
          />
        </div>
      </Group>
    </>
  )
}

export default EnvSetting
