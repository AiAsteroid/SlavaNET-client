import { toast } from 'sonner'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, Code, FilePenLine, Globe, Plus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import BasePage from '@renderer/components/base/base-page'
import EditableList from '@renderer/components/base/base-list-editor'
import {
  FieldRow,
  Group,
  Row,
  SegmentRow,
  SwitchRow
} from '@renderer/components/shell/list-group'
import PacEditorModal from '@renderer/components/sysproxy/pac-editor-modal'
import ByPassEditorModal from '@renderer/components/sysproxy/bypass-editor-modal'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { platform } from '@renderer/utils/init'
import { openUWPTool, triggerSysProxy } from '@renderer/utils/ipc'

const defaultPacScript = `
function FindProxyForURL(url, host) {
  return "PROXY 127.0.0.1:%mixed-port%; SOCKS5 127.0.0.1:%mixed-port%; DIRECT;";
}
`

// Настройки режима прокси на общем наборе строк (components/shell/list-group).
//
// Было: одна общая карточка на десять строк старого вида — переключатель,
// поле, двое вкладок и четыре заливные кнопки в правом углу строк, причём
// подпись у кнопки и заголовок строки часто повторяли друг друга слово в
// слово («Инструмент UWP» / «Открыть инструмент UWP»). Стало: три группы, и
// каждое действие — обычная строка с именем из того же ключа перевода.
//
// Группы делят настройки по тому, КОГДА они применяются: первая — общий
// переключатель системного прокси, он уходит в систему сразу
// (onToggleSysProxy), вторая — параметры, которые копятся в values и уезжают
// кнопкой «Сохранить» в шапке. Эта кнопка — единственная оставшаяся: поле
// применяет правку само (onCommit по уходу и по Enter).
//
// ⚠️ Первые две группы без заголовков намеренно: подходящего ключа перевода
// нет, а новых здесь не заводят — локали правит другой человек. Третья группа
// взяла заголовком существующий ключ списка исключений, и под ним собрались
// все три способа его править: добавить стандартные, открыть YAML-редактор,
// править по строкам.
//
// ⚠️ Подсказки-вопросика у «только активного интерфейса» больше нет: её текст
// (onlyActiveInterfaceHelp) переехал во вторую строку самой настройки, ключ
// перевода тот же.
//
// ⚠️ Значки — только у строк-действий и у общего переключателя. У четырёх
// однотипных параметров они превратились бы в набор случайных картинок.
const Sysproxy: React.FC = () => {
  const { t } = useTranslation()
  const defaultBypass: string[] =
    platform === 'linux'
      ? [
          'localhost',
          '.local',
          '127.0.0.1/8',
          '192.168.0.0/16',
          '10.0.0.0/8',
          '172.16.0.0/12',
          '::1'
        ]
      : platform === 'darwin'
        ? [
            '127.0.0.1/8',
            '192.168.0.0/16',
            '10.0.0.0/8',
            '172.16.0.0/12',
            'localhost',
            '*.local',
            '*.crashlytics.com',
            '<local>'
          ]
        : [
            'localhost',
            '127.*',
            '192.168.*',
            '10.*',
            '172.16.*',
            '172.17.*',
            '172.18.*',
            '172.19.*',
            '172.20.*',
            '172.21.*',
            '172.22.*',
            '172.23.*',
            '172.24.*',
            '172.25.*',
            '172.26.*',
            '172.27.*',
            '172.28.*',
            '172.29.*',
            '172.30.*',
            '172.31.*',
            '<local>'
          ]

  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    sysProxy,
    proxyMode = false,
    onlyActiveDevice = false
  } = appConfig || ({ sysProxy: { enable: true }, proxyMode: false } as AppConfig)
  const [changed, setChanged] = useState(false)
  const [values, originSetValues] = useState({
    enable: sysProxy.enable,
    host: sysProxy.host ?? '',
    bypass: sysProxy.bypass ?? defaultBypass,
    mode: sysProxy.mode ?? 'manual',
    pacScript: sysProxy.pacScript ?? defaultPacScript,
    settingMode: sysProxy.settingMode ?? 'exec'
  })
  useEffect(() => {
    originSetValues((prev) => ({
      ...prev,
      enable: sysProxy.enable
    }))
  }, [sysProxy.enable])
  const [openEditor, setOpenEditor] = useState(false)
  const [openPacEditor, setOpenPacEditor] = useState(false)

  const setValues = (v: typeof values): void => {
    originSetValues(v)
    setChanged(true)
  }
  const onSave = async (): Promise<void> => {
    // check valid TODO
    const prevEnable = sysProxy.enable ?? false
    await patchAppConfig({ sysProxy: values })
    setChanged(false)
    if (!proxyMode) return
    if (values.enable) {
      try {
        await triggerSysProxy(true, onlyActiveDevice)
      } catch (e) {
        toast.error(`${e}`)
        await patchAppConfig({ sysProxy: { enable: false } })
      }
    } else if (prevEnable) {
      try {
        await triggerSysProxy(false, onlyActiveDevice)
      } catch (e) {
        toast.error(`${e}`)
      }
    }
  }

  const onToggleSysProxy = async (enable: boolean): Promise<void> => {
    originSetValues({ ...values, enable })
    setChanged(false)
    await patchAppConfig({ sysProxy: { ...values, enable } })
    if (!proxyMode) return
    try {
      if (enable) {
        await triggerSysProxy(true, onlyActiveDevice)
      } else {
        await triggerSysProxy(false, onlyActiveDevice)
      }
      window.electron.ipcRenderer.send('updateFloatingWindow')
      window.electron.ipcRenderer.send('updateTrayMenu')
    } catch (e) {
      toast.error(`${e}`)
    }
  }

  return (
    <BasePage
      title={t('pages.sysproxy.proxyModeTitle')}
      header={
        changed && (
          <Button className="app-nodrag" size="sm" onClick={onSave}>
            {t('common.save')}
          </Button>
        )
      }
    >
      {openPacEditor && (
        <PacEditorModal
          script={values.pacScript || defaultPacScript}
          onCancel={() => setOpenPacEditor(false)}
          onConfirm={(script: string) => {
            setValues({ ...values, pacScript: script })
            setOpenPacEditor(false)
          }}
        />
      )}
      {openEditor && (
        <ByPassEditorModal
          bypass={values.bypass}
          onCancel={() => setOpenEditor(false)}
          onConfirm={async (list: string[]) => {
            setOpenEditor(false)
            setValues({
              ...values,
              bypass: list
            })
          }}
        />
      )}
      <div className="sysproxy-settings px-4 pt-1">
        <Group>
          <SwitchRow
            icon={Globe}
            label={t('pages.sysproxy.systemProxyToggle')}
            checked={values.enable}
            onCheckedChange={(v) => onToggleSysProxy(v)}
          />
        </Group>

        <Group>
          {/* Пояснение про 127.0.0.1 раньше было подсказкой внутри поля и в
              узкой строке не читалось целиком. Теперь оно во второй строке
              (ключ перевода тот же), а в поле остался сам адрес по умолчанию —
              его переводить нечего. */}
          <FieldRow
            label={t('pages.sysproxy.proxyHost')}
            sub={t('pages.sysproxy.proxyHostPlaceholder')}
            value={values.host}
            placeholder="127.0.0.1"
            width={140}
            onCommit={(next) => setValues({ ...values, host: next })}
          />
          <SegmentRow
            label={t('pages.sysproxy.proxyMode')}
            value={values.mode}
            options={[
              { value: 'manual', label: t('pages.sysproxy.manual') },
              { value: 'auto', label: t('pages.sysproxy.auto') }
            ]}
            onChange={(value) => setValues({ ...values, mode: value })}
          />
          {platform === 'win32' && (
            <Row
              icon={AppWindow}
              label={t('pages.sysproxy.uwpTool')}
              trailing="chevron"
              onClick={async () => {
                await openUWPTool()
              }}
            />
          )}
          {platform === 'darwin' && (
            <>
              <SegmentRow
                label={t('pages.sysproxy.settingMethod')}
                value={values.settingMode}
                options={[
                  { value: 'exec', label: t('pages.sysproxy.execCommand') },
                  { value: 'service', label: t('pages.sysproxy.serviceMode') }
                ]}
                onChange={(value) => setValues({ ...values, settingMode: value })}
              />
              {/* Настройка живёт в конфиге приложения и применяется сразу, а не
                  кнопкой в шапке — поведение прежнее. */}
              <SwitchRow
                label={t('pages.sysproxy.onlyActiveInterface')}
                sub={t('pages.sysproxy.onlyActiveInterfaceHelp')}
                checked={onlyActiveDevice}
                disabled={!values.settingMode || values.settingMode !== 'service'}
                onCheckedChange={(value) => {
                  patchAppConfig({ onlyActiveDevice: value })
                }}
              />
            </>
          )}
          {values.mode === 'auto' && (
            <Row
              icon={Code}
              label={t('pages.sysproxy.editPACScript')}
              trailing="chevron"
              onClick={() => setOpenPacEditor(true)}
            />
          )}
        </Group>

        {values.mode === 'manual' && (
          <Group title={t('pages.sysproxy.proxyBypassList')}>
            <Row
              icon={Plus}
              label={t('pages.sysproxy.addDefaultBypass')}
              onClick={() => {
                setValues({
                  ...values,
                  bypass: Array.from(new Set([...defaultBypass, ...values.bypass]))
                })
              }}
            />
            <Row
              icon={FilePenLine}
              label={t('pages.sysproxy.editBypassList')}
              trailing="chevron"
              onClick={() => setOpenEditor(true)}
            />
            <div className="px-3 py-2">
              <EditableList
                items={values.bypass}
                onChange={(list) => setValues({ ...values, bypass: list as string[] })}
                placeholder={t('pages.sysproxy.exampleBypass')}
                divider={false}
              />
            </div>
          </Group>
        )}
      </div>
    </BasePage>
  )
}

export default Sysproxy
