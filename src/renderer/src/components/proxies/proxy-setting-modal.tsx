import React from 'react'
import {
  ArrowDownWideNarrow,
  ChevronsDownUp,
  Gauge,
  Globe,
  ListTree,
  Table2,
  TableOfContents,
  Timer,
  Unplug
} from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import {
  FieldRow,
  Group,
  SegmentRow,
  SelectRow,
  SwitchRow
} from '@renderer/components/shell/list-group'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { t } from 'i18next'

interface Props {
  onClose: () => void
}

// Настройки групп прокси на общем наборе строк
// (components/shell/list-group). Было: девять строк прежнего вида в одной куче,
// разделённых линиями, и четыре разных контрола — селект, три полосы вкладок,
// два переключателя и три поля разной ширины. Стало три группы по смыслу:
// как показывать (4), что делать при переключении (2) и тест задержки (3).
// Все девять настроек на месте.
//
// ⚠️ У групп surface="muted" — иначе их не видно. Поверхность диалога это
// bg-card/50 поверх затемнения (ui/dialog.tsx), и в тёмной теме она
// складывается почти ровно в цвет bg-card. Подробнее — в list-group.tsx.
//
// ⚠️ Заголовков у групп нет намеренно: подходящих ключей перевода в локалях
// не нашлось, а новых здесь не заводят — локали правит другой человек.
//
// ⚠️ Поля больше не пишут в конфиг на каждую нажатую клавишу. URL теста
// задержки сохранялся через debounce на 500мс (и держал для этого свой
// черновик в состоянии), а два числовых поля писали прямо из onChange —
// очищенное поле уезжало в конфиг как NaN. Теперь правка применяется по уходу
// из поля и по Enter, черновик держит сам FieldRow.
const ProxySettingModal: React.FC<Props> = (props) => {
  const { onClose } = props
  const { appConfig, patchAppConfig } = useAppConfig()

  const {
    proxyCols = 'auto',
    proxyDisplayOrder = 'default',
    groupDisplayLayout = 'single',
    proxyDisplayLayout = 'double',
    autoCloseConnection = true,
    expandProxyGroups = false,
    delayTestUrl,
    delayTestConcurrency,
    delayTestTimeout
  } = appConfig || {}

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="flag-emoji sm:max-w-xl max-h-[80vh] flex flex-col min-h-0"
        showCloseButton={false}
      >
        <DialogHeader className="pb-0">
          <DialogTitle>{t('pages.proxies.proxyGroupSettings')}</DialogTitle>
        </DialogHeader>
        {/* Отступы между шапкой, телом и подвалом даёт сам диалог (gap-4),
            поэтому у последней группы собственный нижний отступ снимаем. */}
        <div className="overflow-y-auto min-h-0 [&>section:last-child]:mb-0">
          <Group surface="muted">
            <SelectRow
              icon={Table2}
              label={t('proxies.proxyNodeColumns')}
              value={proxyCols}
              options={[
                { value: 'auto', label: t('proxies.proxyColsAuto') },
                { value: '1', label: t('proxies.proxyCols1') },
                { value: '2', label: t('proxies.proxyCols2') },
                { value: '3', label: t('proxies.proxyCols3') },
                { value: '4', label: t('proxies.proxyCols4') }
              ]}
              onChange={async (value) => {
                await patchAppConfig({ proxyCols: value })
              }}
            />
            <SegmentRow
              icon={ArrowDownWideNarrow}
              label={t('proxies.nodeSortMethod')}
              value={proxyDisplayOrder}
              options={[
                { value: 'default', label: t('proxies.sortDefault') },
                { value: 'delay', label: t('proxies.sortDelay') },
                { value: 'name', label: t('proxies.sortName') }
              ]}
              onChange={async (value) => {
                await patchAppConfig({ proxyDisplayOrder: value })
              }}
            />
            <SegmentRow
              icon={ListTree}
              label={t('proxies.proxyGroupDetails')}
              value={groupDisplayLayout}
              options={[
                { value: 'hidden', label: t('proxies.displayHidden') },
                { value: 'single', label: t('proxies.displaySingle') },
                { value: 'double', label: t('proxies.displayDouble') }
              ]}
              onChange={async (value) => {
                await patchAppConfig({ groupDisplayLayout: value })
              }}
            />
            <SegmentRow
              icon={TableOfContents}
              label={t('proxies.proxyNodeDetails')}
              value={proxyDisplayLayout}
              options={[
                { value: 'hidden', label: t('proxies.displayHidden') },
                { value: 'single', label: t('proxies.displaySingle') },
                { value: 'double', label: t('proxies.displayDouble') }
              ]}
              onChange={async (value) => {
                await patchAppConfig({ proxyDisplayLayout: value })
              }}
            />
          </Group>

          <Group surface="muted">
            <SwitchRow
              icon={Unplug}
              label={t('proxies.disconnectOnSwitch')}
              checked={autoCloseConnection}
              onCheckedChange={(value) => {
                patchAppConfig({ autoCloseConnection: value })
              }}
            />
            <SwitchRow
              icon={ChevronsDownUp}
              label={t('proxies.expandProxyGroups')}
              checked={expandProxyGroups}
              onCheckedChange={(value) => {
                patchAppConfig({ expandProxyGroups: value })
              }}
            />
          </Group>

          <Group surface="muted">
            <FieldRow
              icon={Globe}
              label={t('proxies.delayTestUrl')}
              value={delayTestUrl ?? ''}
              placeholder={t('proxies.delayTestUrlPlaceholder')}
              width={240}
              onCommit={(next) => patchAppConfig({ delayTestUrl: next })}
            />
            <FieldRow
              icon={Gauge}
              label={t('proxies.delayTestConcurrency')}
              value={delayTestConcurrency?.toString() ?? ''}
              placeholder={t('proxies.delayTestConcurrencyPlaceholder')}
              width={84}
              inputMode="numeric"
              onCommit={(next) => {
                let num = parseInt(next)
                // Пустое поле раньше уезжало в конфиг как NaN. Возвращаем его
                // к тому значению, которое обещает подсказка в поле.
                if (isNaN(num)) num = 50
                return patchAppConfig({ delayTestConcurrency: num })
              }}
            />
            <FieldRow
              icon={Timer}
              label={t('proxies.delayTestTimeout')}
              value={delayTestTimeout?.toString() ?? ''}
              placeholder={t('proxies.delayTestTimeoutPlaceholder')}
              width={84}
              inputMode="numeric"
              onCommit={(next) => {
                let num = parseInt(next)
                if (isNaN(num)) num = 5000
                return patchAppConfig({ delayTestTimeout: num })
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

export default ProxySettingModal
