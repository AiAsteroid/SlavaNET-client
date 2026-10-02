import { toast } from 'sonner'
import { Globe, Route, ScanSearch, Shield, Zap } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import BasePage from '@renderer/components/base/base-page'
import EditableList from '@renderer/components/base/base-list-editor'
import { FieldRow, Group, SwitchRow } from '@renderer/components/shell/list-group'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

// Экран определения доменов на общем наборе строк
// (components/shell/list-group). Было: одна карточка старого вида на десять
// настроек — три переключателя, три поля портов и четыре списка-редактора
// подряд, без заголовков.
//
// ⚠️ Кнопка «Сохранить» в ШАПКЕ осталась: правка собирается в черновик и
// уходит ядру целиком, а не по символу. Поля портов применяют правку в
// черновик по уходу и по Enter (FieldRow) — отдельных «подтвердить» рядом с
// полем здесь не было и не появилось.
//
// ⚠️ Заголовки групп у списков — ТЕ ЖЕ ключи, которыми списки были подписаны
// раньше (pages.sniffer.*). Новых ключей нет.
const Sniffer: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { sniffer } = controledMihomoConfig || {}
  const {
    'parse-pure-ip': parsePureIP = true,
    'force-dns-mapping': forceDNSMapping = true,
    'override-destination': overrideDestination = false,
    sniff = {
      HTTP: { ports: [80, 443], 'override-destination': false },
      TLS: { ports: [443] },
      QUIC: { ports: [] }
    },
    'skip-domain': skipDomain = ['+.push.apple.com'],
    'force-domain': forceDomain = [],
    'skip-dst-address': skipDstAddress = [
      '91.105.192.0/23',
      '91.108.4.0/22',
      '91.108.8.0/21',
      '91.108.16.0/21',
      '91.108.56.0/22',
      '95.161.64.0/20',
      '149.154.160.0/20',
      '185.76.151.0/24',
      '2001:67c:4e8::/48',
      '2001:b28:f23c::/47',
      '2001:b28:f23f::/48',
      '2a0a:f280:203::/48'
    ],
    'skip-src-address': skipSrcAddress = []
  } = sniffer || {}
  const [changed, setChanged] = useState(false)
  const [values, originSetValues] = useState({
    parsePureIP,
    forceDNSMapping,
    overrideDestination,
    sniff,
    skipDomain,
    forceDomain,
    skipDstAddress,
    skipSrcAddress
  })
  const setValues = (v: typeof values): void => {
    originSetValues(v)
    setChanged(true)
  }

  const onSave = async (patch: Partial<MihomoConfig>): Promise<void> => {
    try {
      setChanged(false)
      await patchControledMihomoConfig(patch)
    } catch (e) {
      toast.error(`${e}`)
    }
  }

  const handleSniffPortChange = (protocol: keyof typeof sniff, value: string): void => {
    setValues({
      ...values,
      sniff: {
        ...values.sniff,
        [protocol]: {
          ...values.sniff[protocol],
          ports: value.split(',').map((port) => port.trim())
        }
      }
    })
  }

  return (
    <BasePage
      title={t('pages.sniffer.title')}
      header={
        changed && (
          <Button
            size="sm"
            className="app-nodrag"
            onClick={() =>
              onSave({
                sniffer: {
                  'parse-pure-ip': values.parsePureIP,
                  'force-dns-mapping': values.forceDNSMapping,
                  'override-destination': values.overrideDestination,
                  sniff: values.sniff,
                  'skip-domain': values.skipDomain,
                  'force-domain': values.forceDomain,
                  // ⚠️ Эти два списка редактировались, но в ядро не уезжали:
                  // кнопка «Сохранить» их просто не клала в patch. Человек
                  // правил адреса, нажимал сохранить, и правка пропадала без
                  // единого сообщения. Граблю привёз upstream, она была тут и
                  // до перевода на набор строк (git show HEAD~:…:97).
                  'skip-dst-address': values.skipDstAddress,
                  'skip-src-address': values.skipSrcAddress
                }
              })
            }
          >
            {t('common.save')}
          </Button>
        )
      }
    >
      <div className="px-4 pt-1">
        <Group>
          <SwitchRow
            icon={Route}
            label={t('pages.sniffer.overrideConnectionAddress')}
            checked={values.overrideDestination}
            onCheckedChange={(value) => {
              setValues({
                ...values,
                overrideDestination: value,
                sniff: {
                  ...values.sniff,
                  HTTP: {
                    ...values.sniff.HTTP,
                    'override-destination': value,
                    ports: values.sniff.HTTP?.ports || [80, 443]
                  }
                }
              })
            }}
          />
          <SwitchRow
            icon={ScanSearch}
            label={t('pages.sniffer.sniffRealIPMapping')}
            checked={values.forceDNSMapping}
            onCheckedChange={(value) => {
              setValues({ ...values, forceDNSMapping: value })
            }}
          />
          <SwitchRow
            icon={ScanSearch}
            label={t('pages.sniffer.sniffUnmappedIP')}
            checked={values.parsePureIP}
            onCheckedChange={(value) => {
              setValues({ ...values, parsePureIP: value })
            }}
          />
          {/* Порты применяются по уходу из поля и по Enter: ядру всё равно
              уходит весь черновик по кнопке в шапке. */}
          <FieldRow
            icon={Globe}
            label={t('pages.sniffer.httpPortSniffer')}
            value={(values.sniff.HTTP?.ports ?? []).join(',')}
            width={140}
            placeholder={t('pages.sniffer.portPlaceholder')}
            onCommit={(next) => handleSniffPortChange('HTTP', next)}
          />
          <FieldRow
            icon={Shield}
            label={t('pages.sniffer.tlsPortSniffer')}
            value={(values.sniff.TLS?.ports ?? []).join(',')}
            width={140}
            placeholder={t('pages.sniffer.portPlaceholder')}
            onCommit={(next) => handleSniffPortChange('TLS', next)}
          />
          <FieldRow
            icon={Zap}
            label={t('pages.sniffer.quicPortSniffer')}
            value={(values.sniff.QUIC?.ports ?? []).join(',')}
            width={140}
            placeholder={t('pages.sniffer.portPlaceholder')}
            onCommit={(next) => handleSniffPortChange('QUIC', next)}
          />
        </Group>

        <Group title={t('pages.sniffer.skipDomainSniffing')}>
          <div className="px-3 py-2">
            <EditableList
              items={values.skipDomain}
              onChange={(list) => setValues({ ...values, skipDomain: list as string[] })}
              placeholder={t('pages.sniffer.examplePush')}
              divider={false}
            />
          </div>
        </Group>

        <Group title={t('pages.sniffer.forceDomainSniffing')}>
          <div className="px-3 py-2">
            <EditableList
              items={values.forceDomain}
              onChange={(list) => setValues({ ...values, forceDomain: list as string[] })}
              placeholder={t('pages.sniffer.exampleDomain')}
              divider={false}
            />
          </div>
        </Group>

        <Group title={t('pages.sniffer.skipDestAddressSniffing')}>
          <div className="px-3 py-2">
            <EditableList
              items={values.skipDstAddress}
              onChange={(list) => setValues({ ...values, skipDstAddress: list as string[] })}
              placeholder={t('pages.sniffer.exampleCIDR')}
              divider={false}
            />
          </div>
        </Group>

        <Group title={t('pages.sniffer.skipSourceAddressSniffing')}>
          <div className="px-3 py-2">
            <EditableList
              items={values.skipSrcAddress}
              onChange={(list) => setValues({ ...values, skipSrcAddress: list as string[] })}
              placeholder={t('pages.sniffer.exampleCIDR')}
              divider={false}
            />
          </div>
        </Group>
      </div>
    </BasePage>
  )
}

export default Sniffer
