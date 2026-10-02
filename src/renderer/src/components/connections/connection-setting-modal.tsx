import React from 'react'
import { Image as ImageIcon, ListTree, Timer, Type } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { FieldRow, Group, SegmentRow, SwitchRow } from '@renderer/components/shell/list-group'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { restartMihomoConnections } from '@renderer/utils/ipc'
import { t } from 'i18next'
import { platform } from '@renderer/utils/init'

interface Props {
  onClose: () => void
}

// Настройки списка подключений на общем наборе строк
// (components/shell/list-group). Было: четыре строки прежнего вида, и у каждой
// свой контрол своей высоты — выпадающий список на 150px, два переключателя и
// поле с плашкой «мс» внутри. Стало: четыре строки того же вида, что на экране
// настроек. Все четыре настройки на месте.
//
// ⚠️ У группы surface="muted" — иначе её не видно. Поверхность диалога это
// bg-card/50 поверх затемнения (ui/dialog.tsx), и в тёмной теме она
// складывается почти ровно в цвет bg-card: обычная карточка на ней
// неразличима. Предупреждение подробнее — в list-group.tsx.
//
// ⚠️ Кнопки «Подтвердить» у поля нет и не было: интервал применяется сам —
// по уходу из поля и по Enter (FieldRow). Единица измерения переехала из
// плашки внутри поля в подпись, ключ перевода тот же.
const ConnectionSettingModal: React.FC<Props> = (props) => {
  const { onClose } = props
  const { appConfig, patchAppConfig } = useAppConfig()

  const {
    displayIcon = true,
    displayAppName = true,
    connectionInterval = 500,
    connectionListMode = 'process'
  } = appConfig || {}

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flag-emoji max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('pages.connections.connectionSettings')}</DialogTitle>
        </DialogHeader>
        {/* Отступы между шапкой, телом и подвалом даёт сам диалог (gap-4),
            поэтому у последней группы собственный нижний отступ снимаем. */}
        <div className="[&>section:last-child]:mb-0">
          <Group surface="muted">
            <SegmentRow
              icon={ListTree}
              label={t('pages.connections.connectionListMode')}
              value={connectionListMode}
              options={[
                { value: 'classic', label: t('pages.connections.classicView') },
                { value: 'process', label: t('pages.connections.processView') }
              ]}
              onChange={(value) => {
                patchAppConfig({ connectionListMode: value })
              }}
            />
            <SwitchRow
              icon={ImageIcon}
              label={t('connection.showAppIcon')}
              checked={displayIcon}
              onCheckedChange={(v) => {
                patchAppConfig({ displayIcon: v })
              }}
            />
            {platform === 'darwin' && (
              <SwitchRow
                icon={Type}
                label={t('connection.showAppName')}
                checked={displayAppName}
                onCheckedChange={(v) => {
                  patchAppConfig({ displayAppName: v })
                }}
              />
            )}
            <FieldRow
              icon={Timer}
              label={`${t('connection.refreshInterval')}, ${t('connection.refreshIntervalUnit')}`}
              value={connectionInterval.toString()}
              placeholder={t('connection.refreshIntervalPlaceholder')}
              width={84}
              inputMode="numeric"
              onCommit={async (next) => {
                let num = parseInt(next)
                // Границы были у самого поля и у прежнего onChange: пустое
                // значение возвращаем к обещанному подсказкой, а меньше 100мс
                // не даём — опрос подключений шёл бы без остановки.
                if (isNaN(num)) num = 500
                if (num < 100) num = 100
                await patchAppConfig({ connectionInterval: num })
                await restartMihomoConnections()
              }}
            />
          </Group>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              {t('common.close')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ConnectionSettingModal
