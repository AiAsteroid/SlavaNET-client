import { toast } from 'sonner'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Database, Globe, ListTree, RefreshCcw, Route, Table2, Timer } from 'lucide-react'
import { FieldRow, Group, SegmentRow, SwitchRow } from '@renderer/components/shell/list-group'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { mihomoUpgradeGeo } from '@renderer/utils/ipc'

const defaultGeoxUrl = {
  geoip: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip-lite.dat',
  geosite: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
  mmdb: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb',
  asn: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb'
}

// Ширина поля с адресом базы. Поле выключено по правому краю, поэтому видно
// хвост адреса — ровно ту часть, которой базы отличаются друг от друга
// (geoip-lite.dat против geoip.metadb). Шире 180 брать нельзя: при минимальной
// ширине окна (420px, src/main/index.ts:693) подпись начинает переноситься на
// вторую строку.
const URL_FIELD_WIDTH = 180

// Geo-базы на общем наборе строк (components/shell/list-group). Было: одна
// карточка старого вида на семь строк, где у каждого из четырёх адресов рядом
// с полем появлялась кнопка «Подтвердить» — четыре кнопки, которых не было
// видно, пока не начнёшь правку.
//
// ⚠️ Кнопок «Подтвердить» больше нет (решение владельца 02.10.2026): адрес
// применяется по уходу из поля и по Enter, Escape возвращает прежний. Вместе с
// кнопками ушли и пять состояний, которые их показывали (geoipInput,
// geositeInput, mmdbInput, asnInput, intervalInput) и две синхронизации этих
// состояний с конфигом: черновик теперь хранит сама строка набора.
//
// ⚠️ Ручное обновление баз осталось на том же месте — значком перед
// переключателем (action у строки), как и было в правом углу старой строки.
// Спиннер показывает сама строка (busy), поэтому крутящегося значка больше нет.
const GeoData: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const {
    'geox-url': geoxUrlRaw,
    'geodata-mode': geoMode = false,
    'geo-auto-update': geoAutoUpdate = false,
    'geo-update-interval': geoUpdateInterval = 24
  } = controledMihomoConfig || {}

  const geoxUrl = useMemo(() => ({ ...defaultGeoxUrl, ...geoxUrlRaw }), [geoxUrlRaw])

  const [updating, setUpdating] = useState(false)

  const onUpgradeGeo = async (): Promise<void> => {
    setUpdating(true)
    try {
      await mihomoUpgradeGeo()
      new Notification(t('resources.geoUpdateSuccess'))
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <Group>
      <FieldRow
        icon={Globe}
        label={t('resources.geoipDatabase')}
        value={geoxUrl.geoip}
        width={URL_FIELD_WIDTH}
        onCommit={(next) => patchControledMihomoConfig({ 'geox-url': { ...geoxUrl, geoip: next } })}
      />
      <FieldRow
        icon={ListTree}
        label={t('resources.geositeDatabase')}
        value={geoxUrl.geosite}
        width={URL_FIELD_WIDTH}
        onCommit={(next) =>
          patchControledMihomoConfig({ 'geox-url': { ...geoxUrl, geosite: next } })
        }
      />
      <FieldRow
        icon={Database}
        label={t('resources.mmdbDatabase')}
        value={geoxUrl.mmdb}
        width={URL_FIELD_WIDTH}
        onCommit={(next) => patchControledMihomoConfig({ 'geox-url': { ...geoxUrl, mmdb: next } })}
      />
      <FieldRow
        icon={Route}
        label={t('resources.asnDatabase')}
        value={geoxUrl.asn}
        width={URL_FIELD_WIDTH}
        onCommit={(next) => patchControledMihomoConfig({ 'geox-url': { ...geoxUrl, asn: next } })}
      />
      <SegmentRow
        icon={Table2}
        label={t('resources.geoipDataMode')}
        value={geoMode ? 'dat' : 'db'}
        options={[
          { value: 'db', label: 'db' },
          { value: 'dat', label: 'dat' }
        ]}
        onChange={(value) => {
          patchControledMihomoConfig({ 'geodata-mode': value === 'dat' })
        }}
      />
      <SwitchRow
        icon={Clock}
        label={t('resources.autoUpdateGeoData')}
        checked={geoAutoUpdate}
        busy={updating}
        onCheckedChange={(value) => {
          patchControledMihomoConfig({ 'geo-auto-update': value })
        }}
        action={{ icon: RefreshCcw, label: t('common.update'), onClick: onUpgradeGeo }}
      />
      {geoAutoUpdate && (
        <FieldRow
          icon={Timer}
          label={t('resources.updateInterval')}
          value={geoUpdateInterval.toString()}
          width={72}
          inputMode="numeric"
          onCommit={async (next) => {
            const num = parseInt(next)
            // ⚠️ Непригодное значение ОТВЕРГАЕТСЯ, а не подтягивается к
            // ближайшему допустимому. Ноль человек ставит, думая «значит, не
            // обновлять»; подтяжка к одному часу заставляла бы ядро качать
            // все четыре Geo-базы каждый час, и узнал бы он об этом только по
            // трафику. Записываем прежний интервал — патч становится
            // пустышкой, и в ядро не уходит ничего.
            await patchControledMihomoConfig({
              'geo-update-interval': !isNaN(num) && num > 0 ? num : geoUpdateInterval
            })
          }}
        />
      )}
    </Group>
  )
}

export default GeoData
