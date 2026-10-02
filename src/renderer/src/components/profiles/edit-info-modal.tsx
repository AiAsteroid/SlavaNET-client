import React, { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import {
  FieldRow,
  Group,
  SegmentRow,
  SwitchRow
} from '@renderer/components/shell/list-group'
import { Spinner } from '@renderer/components/ui/spinner'
import { getFilePath, readTextFile, mihomoHotReloadConfig } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import {
  ClipboardPaste,
  ChevronDown,
  FileUp,
  FilePlus2,
  Check,
  FileText,
  Globe,
  MonitorSmartphone,
  Network,
  RefreshCw,
  Shield,
  Tag,
  Timer
} from 'lucide-react'

interface Props {
  item: ProfileItem
  isCurrent: boolean
  updateProfileItem: (item: ProfileItem) => Promise<void>
  onClose: () => void
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Окно профиля на общем наборе строк (components/shell/list-group). Было: три
// самодельные карточки (rounded-xl border bg-accent/20) со строками прежнего
// вида внутри, и в каждой свой контрол — поле, переключатель, пара
// кнопок «Удалённый/Локальный». Стало: те же строки, что на экране настроек.
//
// Настройки все на месте: при импорте семь (тип, имя, UA, проверка формата,
// обновление через прокси, автообновление, интервал), при правке столько же —
// имя и адрес подписки в первой группе, остальные пять во второй.
//
// ⚠️ У групп surface="muted" — иначе их не видно. Поверхность диалога это
// bg-card/50 поверх затемнения (ui/dialog.tsx), и в тёмной теме она
// складывается почти ровно в цвет bg-card. Подробнее — в list-group.tsx.
//
// ⚠️ Подсказки-вопросика у интервала обновления больше нет: её текст
// (profile.updateIntervalLockedHelp) переехал во вторую строку самой
// настройки и показывается ровно тогда же — когда интервал задан удалённо.
// Ключ перевода тот же.
//
// ⚠️ Поля правят черновик values, а не конфиг: применяет его кнопка в подвале
// окна, и она остаётся как была. Поле отдаёт правку черновику по уходу и по
// Enter (FieldRow) — нажатие на «Сохранить» сначала уводит фокус из поля,
// поэтому последняя правка в сохранение попадает.
const EditInfoModal: React.FC<Props> = (props) => {
  const { t } = useTranslation()
  const { item, isCurrent, updateProfileItem, onClose } = props
  const [values, setValues] = useState({ ...item, autoUpdate: item.autoUpdate ?? true })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [urlTouched, setUrlTouched] = useState(false)
  const [localFileName, setLocalFileName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  const isNew = !item.id
  const isLocal = values.type === 'local'
  const urlInvalid = !isLocal && urlTouched && !!values.url && !isValidUrl(values.url)

  const canImport = isNew
    ? isLocal
      ? !!values.file
      : isValidUrl(values.url || '')
    : true

  const onSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const itemToSave = { ...values }
      await updateProfileItem(itemToSave)
      if (item.id && isCurrent) {
        await mihomoHotReloadConfig()
      }
      closeRef.current?.click()
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      setSaving(false)
    }
  }

  const handlePaste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setValues({ ...values, url: text.trim() })
        setUrlTouched(true)
      }
    } catch {
      // clipboard access denied
    }
  }

  const handleSelectFile = async (): Promise<void> => {
    try {
      const files = await getFilePath(['yml', 'yaml'])
      if (files?.length) {
        const content = await readTextFile(files[0])
        const fileName = files[0].split('/').pop()?.split('\\').pop() || ''
        setLocalFileName(fileName)
        setValues({
          ...values,
          type: 'local',
          file: content,
          name: values.name || fileName
        })
      }
    } catch (e) {
      toast.error(`${e}`)
    }
  }

  const handleCreateEmpty = (): void => {
    setLocalFileName(null)
    setValues({
      ...values,
      type: 'local',
      file: 'proxies: []\nproxy-groups: []\nrules: []',
      name: values.name || t('profile.blankSubscription')
    })
  }

  const switchToType = (type: 'remote' | 'local'): void => {
    if (type === values.type) return
    setValues({
      ...values,
      type,
      url: type === 'local' ? undefined : values.url,
      file: type === 'remote' ? undefined : values.file
    })
    setLocalFileName(null)
    setUrlTouched(false)
  }

  // Пять настроек удалённой подписки идут и при импорте, и при правке —
  // поэтому лежат одним набором строк, а не двумя копиями.
  const remoteRows = (
    <>
      <FieldRow
        icon={MonitorSmartphone}
        label={t('profile.customUA')}
        value={values.ua ?? ''}
        width={200}
        onCommit={(next) => setValues({ ...values, ua: next.trim() || undefined })}
      />
      <SwitchRow
        icon={Shield}
        label={t('profile.verifyFormat')}
        checked={values.verify ?? true}
        onCheckedChange={(v) => setValues({ ...values, verify: v })}
      />
      <SwitchRow
        icon={Network}
        label={t('profile.useProxyUpdate')}
        checked={values.useProxy ?? false}
        onCheckedChange={(v) => setValues({ ...values, useProxy: v })}
      />
      <SwitchRow
        icon={RefreshCw}
        label={t('profile.autoUpdate')}
        checked={values.autoUpdate ?? false}
        onCheckedChange={(v) => setValues({ ...values, autoUpdate: v })}
      />
      {values.autoUpdate && (
        <FieldRow
          icon={Timer}
          label={t('profile.updateIntervalMinutes')}
          sub={values.locked ? t('profile.updateIntervalLockedHelp') : undefined}
          value={values.interval?.toString() ?? ''}
          width={84}
          inputMode="numeric"
          disabled={values.locked}
          onCommit={(next) => {
            let num = parseInt(next)
            // Пустое поле раньше уезжало в профиль как NaN. Главный процесс
            // всё равно читает его как `interval || 0` (main/config/profile),
            // так что ноль — то же самое, только видно.
            if (isNaN(num)) num = 0
            setValues({ ...values, interval: num })
          }}
        />
      )}
    </>
  )

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className={cn(
          'sm:max-w-none',
          'w-120'
        )}
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogClose ref={closeRef} className="hidden" />
        <DialogHeader className="app-drag">
          <DialogTitle>
            {isNew ? t('profile.importRemoteConfig') : t('profile.editInfo')}
          </DialogTitle>
        </DialogHeader>

        {isNew ? (
          <div className="flex flex-col gap-3 [&>section:last-child]:mb-0">
            {/* Source: URL input or local file picker */}
            {isLocal ? (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-2"
                    onClick={handleSelectFile}
                  >
                    <FileUp className="size-4" />
                    {t('profile.selectFile')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-2"
                    onClick={handleCreateEmpty}
                  >
                    <FilePlus2 className="size-4" />
                    {t('profile.createEmpty')}
                  </Button>
                </div>
                {values.file && (
                  <div className="flex items-center gap-2 text-xs text-success">
                    <Check className="size-3.5" />
                    {localFileName
                      ? `${t('profile.fileSelected')}: ${localFileName}`
                      : t('profile.blankSubscription')}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="relative">
                  <Input
                    data-guide="profile-import-url-input"
                    className={cn(
                      'h-9 pr-9',
                      urlInvalid && 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/50'
                    )}
                    placeholder={t('profile.urlPlaceholder')}
                    value={values.url || ''}
                    onChange={(e) => {
                      setValues({ ...values, url: e.target.value })
                      if (!urlTouched) setUrlTouched(true)
                    }}
                    onBlur={() => setUrlTouched(true)}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-guide="profile-import-paste-btn"
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={handlePaste}
                      >
                        <ClipboardPaste className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('profile.pasteFromClipboard')}</TooltipContent>
                  </Tooltip>
                </div>
                {urlInvalid && (
                  <p className="text-xs text-destructive">{t('profile.invalidUrl')}</p>
                )}
              </div>
            )}

            {/* Advanced settings toggle */}
            <button
              type="button"
              className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-200',
                  showAdvanced && 'rotate-180'
                )}
              />
              {t('profile.advancedSettings')}
            </button>

            {showAdvanced && (
              <Group surface="muted">
                <SegmentRow
                  icon={FileText}
                  label={t('profile.profileType')}
                  value={values.type}
                  options={[
                    { value: 'remote', label: t('common.remote') },
                    { value: 'local', label: t('common.local') }
                  ]}
                  onChange={switchToType}
                />
                <FieldRow
                  icon={Tag}
                  label={t('profile.name')}
                  value={values.name}
                  width={200}
                  onCommit={(next) => setValues({ ...values, name: next })}
                />
                {!isLocal && remoteRows}
              </Group>
            )}
          </div>
        ) : (
          /* Edit existing profile */
          <div className="overflow-y-auto max-h-[60vh] [&>section:last-child]:mb-0">
            {/* Identity */}
            <Group surface="muted">
              <FieldRow
                icon={Tag}
                label={t('profile.name')}
                value={values.name}
                width={200}
                onCommit={(next) => setValues({ ...values, name: next })}
              />
              {values.type === 'remote' && (
                <FieldRow
                  icon={Globe}
                  label={t('profile.subscriptionAddress')}
                  value={values.url ?? ''}
                  width={220}
                  onCommit={(next) => setValues({ ...values, url: next })}
                />
              )}
            </Group>
            {/* Remote settings */}
            {values.type === 'remote' && <Group surface="muted">{remoteRows}</Group>}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              {t('common.cancel')}
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={onSave}
            disabled={!canImport || saving}
            data-guide={isNew ? 'profile-import-submit' : undefined}
          >
            <span className="relative inline-flex items-center justify-center">
              {saving && <Spinner className="size-4 absolute" />}
              <span className={saving ? 'invisible' : undefined}>
                {isNew ? t('common.import') : t('common.save')}
              </span>
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default EditInfoModal
