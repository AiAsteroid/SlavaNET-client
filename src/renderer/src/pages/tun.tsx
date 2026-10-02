import { toast } from 'sonner'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Network, Shield } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import BasePage from '@renderer/components/base/base-page'
import EditableList from '@renderer/components/base/base-list-editor'
import {
  FieldRow,
  Group,
  Row,
  SegmentRow,
  SelectRow,
  SwitchRow
} from '@renderer/components/shell/list-group'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { platform } from '@renderer/utils/init'
import { restartCore, setupFirewall } from '@renderer/utils/ipc'

// ⚠️ MTU по умолчанию — та же 1500, что подставляется при чтении конфига ниже.
// Отдельной константой она нужна полю, которое применяет правку само: на
// пустую строку оно обязано чем-то ответить, а parseInt('') — это NaN. Прежнее
// поле писало этот NaN прямо в values, и в конфиг ядра он уходил как null,
// молча ломая туннель.
const DEFAULT_MTU = 1500

// Настройки TUN на общем наборе строк (components/shell/list-group).
//
// Было: одна общая карточка на тринадцать строк старого вида, где
// переключатели, поля ввода и заливные кнопки стояли вперемешку и каждая форма
// строки держала свою геометрию. Стало: три группы и те же тринадцать
// настроек, ни одна не потерялась.
//
// Группы делят настройки по тому, КОГДА они применяются: первая — то, что
// уходит в систему сразу (управление TUN, брандмауэр, системный DNS), вторая —
// параметры самого туннеля, которые копятся в values и уезжают в ядро кнопкой
// «Сохранить» в шапке. Эта кнопка — единственная оставшаяся: поля применяют
// правку сами (onCommit по уходу и по Enter), и «Подтвердить» рядом с полем
// больше нет.
//
// ⚠️ Первые две группы без заголовков намеренно: подходящего ключа перевода
// нет, а новых здесь не заводят — локали правит другой человек. Третья группа
// забрала заголовок у списка (excludeCustomNetworks), иначе он повторялся бы
// дважды: в шапке группы и внутри самого редактора.
//
// ⚠️ Значки — только у строк, которые включают целый механизм или ведут
// наружу. У девяти однотипных параметров туннеля они превратились бы в набор
// случайных картинок, который не помогает читать, а мешает.
const Tun: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { autoSetDNSMode = 'exec', controlTun = false } = appConfig || {}
  const { tun } = controledMihomoConfig || {}
  const [loading, setLoading] = useState(false)
  const {
    device = platform === 'darwin' ? undefined : 'mihomo',
    stack = 'mixed',
    'auto-route': autoRoute = true,
    'auto-redirect': autoRedirect = false,
    'auto-detect-interface': autoDetectInterface = true,
    'dns-hijack': dnsHijack = ['any:53'],
    'route-exclude-address': routeExcludeAddress = [],
    'strict-route': strictRoute = false,
    'disable-icmp-forwarding': disableIcmpForwarding = false,
    mtu = DEFAULT_MTU
  } = tun || {}
  const [changed, setChanged] = useState(false)
  const [values, originSetValues] = useState({
    device,
    stack,
    autoRoute,
    autoRedirect,
    autoDetectInterface,
    dnsHijack,
    strictRoute,
    routeExcludeAddress,
    disableIcmpForwarding,
    mtu
  })
  const setValues = (v: typeof values): void => {
    originSetValues(v)
    setChanged(true)
  }

  const onSave = async (patch: Partial<MihomoConfig>): Promise<void> => {
    try {
      await patchControledMihomoConfig(patch)
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      setChanged(false)
    }
  }

  return (
    <BasePage
      title={t('pages.tun.title')}
      header={
        changed && (
          <Button
            size="sm"
            className="app-nodrag"
            onClick={() =>
              onSave({
                tun: {
                  device: values.device,
                  stack: values.stack,
                  'auto-route': values.autoRoute,
                  'auto-redirect': values.autoRedirect,
                  'auto-detect-interface': values.autoDetectInterface,
                  'dns-hijack': values.dnsHijack,
                  'strict-route': values.strictRoute,
                  'route-exclude-address': values.routeExcludeAddress,
                  'disable-icmp-forwarding': values.disableIcmpForwarding,
                  mtu: values.mtu
                }
              })
            }
          >
            {t('common.save')}
          </Button>
        )
      }
    >
      <div className="tun-settings px-4 pt-1">
        <Group>
          <SwitchRow
            icon={Network}
            label={t('pages.tun.takeOverTun')}
            checked={controlTun}
            onCheckedChange={async (value) => {
              try {
                await patchAppConfig({ controlTun: value })
                await patchControledMihomoConfig(value ? {} : { tun: { enable: false } })
              } catch (e) {
                toast.error(`${e}`)
              }
            }}
          />
          {/* Сброс брандмауэра перезапускает ядро — строка-действие, а не
              настройка. Спиннер теперь у самой строки (busy), отдельная
              заливная кнопка внутри строки не нужна. */}
          {platform === 'win32' && (
            <Row
              icon={Shield}
              label={t('pages.tun.resetFirewall')}
              busy={loading}
              disabled={loading}
              trailing="chevron"
              onClick={async () => {
                setLoading(true)
                try {
                  await setupFirewall()
                  new Notification(t('pages.tun.firewallResetSuccess'))
                  await restartCore()
                } catch (e) {
                  toast.error(`${e}`)
                } finally {
                  setLoading(false)
                }
              }}
            />
          )}
          {/* Три способа с длинными именами («Не устанавливать автоматически»)
              в сегменты не влезают — остаётся выбор из списка, как и было. */}
          {platform === 'darwin' && (
            <SelectRow
              icon={Globe}
              label={t('pages.tun.autoSetSystemDNS')}
              value={autoSetDNSMode}
              options={[
                { value: 'none', label: t('pages.tun.noAutoSet') },
                { value: 'exec', label: t('pages.tun.execCommand') },
                { value: 'service', label: t('pages.tun.serviceMode') }
              ]}
              onChange={async (value) => {
                await patchAppConfig({ autoSetDNSMode: value })
              }}
            />
          )}
        </Group>

        <Group>
          <SegmentRow
            label={t('pages.tun.tunModeStack')}
            value={values.stack}
            options={[
              { value: 'gvisor', label: 'gVisor' },
              { value: 'mixed', label: 'Mixed' },
              { value: 'system', label: 'System' }
            ]}
            onChange={(value) => setValues({ ...values, stack: value })}
          />
          {platform !== 'darwin' && (
            <>
              <FieldRow
                label={t('pages.tun.tunCardName')}
                value={values.device ?? ''}
                width={120}
                onCommit={(next) => setValues({ ...values, device: next })}
              />
              <SwitchRow
                label={t('pages.tun.strictRoute')}
                checked={values.strictRoute}
                onCheckedChange={(value) => setValues({ ...values, strictRoute: value })}
              />
            </>
          )}
          <SwitchRow
            label={t('pages.tun.autoSetRouteRules')}
            checked={values.autoRoute}
            onCheckedChange={(value) => setValues({ ...values, autoRoute: value })}
          />
          {platform === 'linux' && (
            <SwitchRow
              label={t('pages.tun.autoSetTCPRedirect')}
              checked={values.autoRedirect}
              onCheckedChange={(value) => setValues({ ...values, autoRedirect: value })}
            />
          )}
          <SwitchRow
            label={t('pages.tun.autoSelectTrafficExit')}
            checked={values.autoDetectInterface}
            onCheckedChange={(value) => setValues({ ...values, autoDetectInterface: value })}
          />
          {/* Переключатель показывает пересылку, а конфиг хранит её запрет:
              значение инвертировано ровно так же, как было. */}
          <SwitchRow
            label={t('pages.tun.icmpForwarding')}
            checked={!values.disableIcmpForwarding}
            onCheckedChange={(value) => setValues({ ...values, disableIcmpForwarding: !value })}
          />
          <FieldRow
            label="MTU"
            value={values.mtu.toString()}
            width={80}
            inputMode="numeric"
            onCommit={(next) => {
              const num = parseInt(next)
              setValues({ ...values, mtu: isNaN(num) ? DEFAULT_MTU : num })
            }}
          />
          {/* Несколько адресов через запятую — так же, как в прежнем поле;
              разбор строки остался прежним. */}
          <FieldRow
            label={t('pages.tun.dnsHijack')}
            value={values.dnsHijack.join(',')}
            width={140}
            onCommit={(next) =>
              setValues({ ...values, dnsHijack: next !== '' ? next.split(',') : [] })
            }
          />
        </Group>

        <Group title={t('pages.tun.excludeCustomNetworks')}>
          <div className="px-3 py-2">
            <EditableList
              items={values.routeExcludeAddress}
              placeholder={t('pages.tun.exampleNetwork')}
              onChange={(list) => setValues({ ...values, routeExcludeAddress: list as string[] })}
              divider={false}
            />
          </div>
        </Group>
      </div>
    </BasePage>
  )
}

export default Tun
