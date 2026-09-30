import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import {
  CircleAlert,
  Laptop,
  LogIn,
  MonitorSmartphone,
  Pencil,
  Smartphone,
  Unplug
} from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@renderer/components/ui/sheet'
import { Group, Row } from '@renderer/components/shell/list-group'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'

// Лист одного устройства: всё, что можно сделать с железкой, живёт ЗДЕСЬ, а не
// в строке списка. В списке кнопок нет намеренно — промах мимо строки не должен
// стоить человеку устройства. И два действия внутри листа разведены по ДВУМ
// карточкам с зазором: кабинет пришёл к раздельным плашкам после того, как
// промах по соседней кнопке стоил людям устройства, и мы повторяем это решение,
// а не изобретаем своё.

// ⚠️ Предел длины имени — не наша выдумка, а копия серверного ALIAS_MAX_LENGTH
// (app/database/crud/user_device_alias.py:24, там же длина колонки в БД).
// Сервер молча срежет лишнее, поэтому режем тут же: иначе человек увидит на
// экране одно, а в кабинете другое.
export const ALIAS_MAX_LENGTH = 64

// Сколько символов hwid показываем для сверки. Восьми хватает, чтобы отличить
// два одинаковых «iPad Pro» друг от друга, и мало, чтобы строка стала шумом.
const HWID_PREFIX_LENGTH = 8

// Отказы берём готовыми союзами главного процесса (CabinetDeviceRenameResult и
// CabinetDeviceRemoveResult в src/shared/types/app.d.ts:398 и :411) — свой
// набор состояний тут был бы вторым источником правды о том же самом.
// Разбирать их поштучно всё равно приходится: у 'unauthorized' и
// 'noSubscription' нет message намеренно — это не сообщения, а развилки, и
// показать надо вход или предложение подписки, а не строку текста.
//
// ⚠️ У отключения НЕТ состояния 'gone', и это не упущение: панель на удаление
// уже отсутствующего устройства отвечает 404, а клиент панели считает это
// успехом (app/external/remnawave_api.py:1727-1728). То есть «отключили» и
// «его и так не было» с нашей стороны неразличимы — и это ровно то поведение,
// которое нам нужно: результат на экране одинаков.
type RenameFailure = Exclude<CabinetDeviceRenameResult, { state: 'ok' }>
type RemoveFailure = Exclude<CabinetDeviceRemoveResult, { state: 'ok' }>

export interface DeviceSheetProps {
  open: boolean
  /**
   * Закрытие листа. ⚠️ Лист сам отказывается закрываться, пока в полёте
   * запрос: ответ, пришедший в закрытый лист, человек не увидит и не узнает,
   * сработало ли. Закрытие по X, по Escape и по клику мимо идёт через этот же
   * колбэк, поэтому вето одно на все три пути.
   */
  onOpenChange: (open: boolean) => void
  /**
   * Снимок устройства. ⚠️ Родитель ОБЯЗАН держать этот снимок, пока лист
   * открыт, даже если устройство пропало из свежего ответа кабинета: иначе
   * лист опустеет на полпути. Пропало — оставь снимок и подними `missing`.
   * `null` при open={true} допустим (лист просто не рисуется), но это признак
   * того, что родитель уронил снимок.
   */
  device: CabinetDevice | null
  /**
   * Устройства нет в ПОСЛЕДНЕМ ответе кабинета.
   * ⚠️ Это НЕ значит «устройство отключилось»: кабинет отдаёт 200 и пустой
   * список ещё и когда ему не ответила панель (devices.py:1012-1018), и
   * различить два случая по ответу нельзя. Поэтому текст в листе хеджирован, а
   * кнопки остаются живыми — запрет здесь был бы вреден именно при сбое панели.
   */
  missing?: boolean
  /**
   * Задать имя. Пустая строка = снять алиас.
   * Подходит `renameCabinetDevice` из @renderer/utils/ipc:435 как есть.
   */
  onRename: (hwid: string, name: string) => Promise<CabinetDeviceRenameResult>
  /** Отключить устройство. Подходит `removeCabinetDevice` (ipc.ts:447) как есть. */
  onForget: (hwid: string) => Promise<CabinetDeviceRemoveResult>
  /**
   * Имя сохранено. `localName` — то, что вернул сервер; undefined = имя
   * сброшено. Родителю пора поправить свой список И сбросить модульный кэш
   * устройств, иначе следующий заход на вкладку вернёт старое имя.
   */
  onRenamed?: (hwid: string, localName?: string) => void
  /** Устройство отключено: убрать из списка и сбросить кэш. Лист закроется сам. */
  onForgotten?: (hwid: string) => void
  /**
   * Кабинет не числит устройство за аккаунтом (приходит только на
   * переименовании — см. заметку про 'gone' выше). Убрать из списка.
   */
  onGone?: (hwid: string) => void
  /** Предложить вход. Нет колбэка — покажем только текст, без кнопки. */
  onSignIn?: () => void
}

// ⚠️ Два хелпера ниже — намеренная копия из pages/subscription.tsx:58-71.
// Править чужой файл в этой задаче нельзя, а лист обязан подписывать устройство
// ТОЧНО так же, как строка списка, из которой его открыли: иначе нажатие на
// «iPad Pro» откроет лист «Без имени». Вынести в общий util — первая же уборка
// после интеграции (см. risks).

// Иконка по платформе. Сверяем по подстроке, а не по равенству: панель отдаёт и
// 'iOS', и 'iPhone OS 18.1', и подставленное кабинетом 'Unknown'.
function deviceIcon(platform: string): typeof Laptop {
  const value = platform.toLowerCase()
  if (/ios|iphone|ipad|android|harmony/.test(value)) return Smartphone
  if (/mac|darwin|win|linux|ubuntu|debian/.test(value)) return Laptop
  return MonitorSmartphone
}

// 'Unknown' подставляет сам кабинет, когда панель не дала поля. Это не ответ, а
// его отсутствие, и показывать его как имя устройства нельзя.
function isBlank(value?: string): boolean {
  const raw = (value ?? '').trim()
  return raw === '' || raw.toLowerCase() === 'unknown'
}

// Длина в КОДОВЫХ ТОЧКАХ, а не в единицах UTF-16. Так считает питон на сервере
// (срез в normalize_alias идёт по символам) и так же — normalizeDeviceName в
// главном процессе (src/main/resolve/connect.ts:1370-1376). Считать здесь через
// value.length значило бы пускать в поле вдвое меньше эмодзи, чем примут оба
// шлагбаума дальше.
function aliasLength(value: string): number {
  return Array.from(value).length
}

// Обрезка по тому же счёту. Срезом по массиву кодовых точек, а не
// value.slice(): обычный срез разрубил бы сурогатную пару пополам и оставил в
// поле половину эмодзи.
function clampAlias(value: string): string {
  const points = Array.from(value)
  return points.length <= ALIAS_MAX_LENGTH ? value : points.slice(0, ALIAS_MAX_LENGTH).join('')
}

/**
 * Копия серверной normalize_alias (user_device_alias.py:26-32): обрезать по
 * краям, сжать пробелы в один, отрезать по длине.
 *
 * ⚠️ Нужна нам не для отправки (сервер всё равно нормализует сам), а чтобы
 * СРАВНИТЬ набранное с текущим: «Мак  Славы» и «Мак Славы» для сервера одно и
 * то же, и без такого сравнения лист отправлял бы PATCH на пустом месте.
 */
function normalizeAlias(value: string): string {
  return clampAlias(value.split(/\s+/).filter(Boolean).join(' '))
}

const DeviceSheet: React.FC<DeviceSheetProps> = ({
  open,
  onOpenChange,
  device,
  missing = false,
  onRename,
  onForget,
  onRenamed,
  onForgotten,
  onGone,
  onSignIn
}) => {
  const { t } = useTranslation()

  // Фаза листа. Одна переменная вместо трёх флагов: «переименовываю» и
  // «подтверждаю отключение» взаимно исключают друг друга, и на двух boolean
  // они рано или поздно оказались бы включены одновременно.
  const [phase, setPhase] = useState<'view' | 'rename' | 'confirm-forget' | 'gone'>('view')
  const [draft, setDraft] = useState('')
  const [renameFailure, setRenameFailure] = useState<RenameFailure | null>(null)
  const [forgetFailure, setForgetFailure] = useState<RemoveFailure | null>(null)
  // Имя ИЗ ОТВЕТА СЕРВЕРА. Держим отдельно от props: родительский список живёт
  // на модульном кэше (pages/subscription.tsx:53, TTL 60 с) и может ещё минуту
  // отдавать старое имя. Без этого поля человек сохранил бы имя и увидел
  // прежнее. null = сервер по этому устройству ещё ничего не говорил,
  // undefined = сервер сказал «алиаса нет».
  const [serverName, setServerName] = useState<string | null | undefined>(null)

  // Один запрос в полёте. Ref — единственный честный замок: setState
  // асинхронный, и два нажатия в одном тике проскочили бы мимо state.
  const busyRef = useRef<'rename' | 'forget' | null>(null)
  const [busy, setBusy] = useState<'rename' | 'forget' | null>(null)
  // Номер операции. Ответ со старым номером выбрасываем: лист успели закрыть
  // или переключить на другое устройство, и применять к нему чужой результат
  // нельзя.
  const seqRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const hwid = device?.hwid ?? ''
  // hwid пустой — панель не дала идентификатора (mapDevice в
  // src/main/resolve/connect.ts:521 честно кладёт ''). Адресовать такое
  // устройство нечем: и PATCH, и DELETE строятся по hwid, и запрос с пустым
  // ушёл бы на .../devices/ — а это сосед ручки «отключить ВСЕ устройства».
  // На сервере такой путь сейчас даёт 404 (redirect_slashes=False,
  // app/webapi/app.py:186), но ставить сохранность всех устройств человека в
  // зависимость от чужой настройки мы не станем: не отправляем вовсе.
  const addressable = hwid !== ''

  // Сброс при смене устройства и при закрытии: иначе на новом устройстве
  // всплывёт прошлая ошибка и прошлый черновик имени. Здесь же гасится замок и
  // обесценивается номер операции — ответ уже летящего запроса будет отброшен.
  useEffect(() => {
    seqRef.current += 1
    busyRef.current = null
    setBusy(null)
    setPhase('view')
    setDraft('')
    setRenameFailure(null)
    setForgetFailure(null)
    setServerName(null)
  }, [hwid, open])

  // Фокус в поле при входе в переименование. Задержки нет: Radix к этому
  // моменту уже отдал фокус содержимому листа, и наш focus() последний.
  useEffect(() => {
    if (phase === 'rename') inputRef.current?.focus()
  }, [phase])

  // Текущая кличка: ответ сервера старше props, он свежее кэша родителя.
  const alias = serverName === null ? device?.localName : (serverName ?? undefined)
  const hasAlias = !isBlank(alias)

  // Имя по убыванию понятности: своя кличка -> модель -> платформа -> «Без
  // имени». Ровно та же лестница, что в строке списка.
  const title = useMemo(() => {
    if (!isBlank(alias)) return (alias ?? '').trim()
    if (!isBlank(device?.model)) return (device?.model ?? '').trim()
    if (!isBlank(device?.platform)) return (device?.platform ?? '').trim()
    return t('common.unnamed')
  }, [alias, device?.model, device?.platform, t])

  const platformLine = useMemo(() => {
    const platform = isBlank(device?.platform)
      ? t('pages.subscription.devices.platformUnknown')
      : (device?.platform ?? '').trim()
    // Версию ОС приклеиваем к платформе, а не отдельной строкой: «macOS» и
    // «26.6.2» по отдельности ничего не значат.
    return device?.osVersion ? `${platform} ${device.osVersion}` : platform
  }, [device?.platform, device?.osVersion, t])

  const lastSeenLine = useMemo(() => {
    if (!device?.lastSeenAt) return t('pages.subscription.devices.lastSeenUnknown')
    // ⚠️ Время из будущего прижимаем к «сейчас»: часы панели и Мака расходятся
    // на минуты, а dayjs на будущей метке скажет «через 2 минуты», и строка
    // «был через 2 минуты» читается как поломка приложения.
    const at = Math.min(device.lastSeenAt, Date.now())
    return t('pages.subscription.deviceSheet.lastSeen', { ago: dayjs(at).fromNow() })
  }, [device?.lastSeenAt, t])

  // Закрытие с вето на время запроса — одно на X, Escape и клик мимо.
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (!next && busyRef.current) return
      onOpenChange(next)
    },
    [onOpenChange]
  )

  const startRename = useCallback((): void => {
    if (busyRef.current) return
    // В поле кладём ТЕКУЩУЮ кличку, а не отображаемое имя: иначе человек,
    // открывший переименование на устройстве без клички, получил бы в поле
    // модель от панели и, ничего не тронув, сохранил бы её как свою.
    setDraft(isBlank(alias) ? '' : (alias ?? '').trim())
    setRenameFailure(null)
    setForgetFailure(null)
    setPhase('rename')
  }, [alias])

  const cancelRename = useCallback((): void => {
    if (busyRef.current) return
    setDraft('')
    setRenameFailure(null)
    setPhase('view')
  }, [])

  const submitRename = useCallback((): void => {
    if (busyRef.current || !addressable) return
    const next = normalizeAlias(draft)
    // Ничего не изменилось — запрос не отправляем вовсе.
    if (next === normalizeAlias(alias ?? '')) {
      setRenameFailure(null)
      setPhase('view')
      setDraft('')
      return
    }
    busyRef.current = 'rename'
    setBusy('rename')
    setRenameFailure(null)
    const seq = ++seqRef.current
    void onRename(hwid, next)
      .then((result) => {
        if (seqRef.current !== seq) return
        busyRef.current = null
        setBusy(null)
        if (result.state === 'ok') {
          // Показываем имя ИЗ ОТВЕТА: сервер сжал пробелы и, возможно, срезал
          // хвост, и его версия — единственная правда.
          setServerName(result.localName)
          setDraft('')
          setPhase('view')
          onRenamed?.(hwid, result.localName)
          return
        }
        if (result.state === 'gone') {
          setPhase('gone')
          onGone?.(hwid)
          return
        }
        // Остаёмся в поле: человек видит свой текст и может повторить Enter.
        setRenameFailure(result)
      })
      .catch(() => {
        if (seqRef.current !== seq) return
        busyRef.current = null
        setBusy(null)
        // Обёртка обещает не бросать (ipcErrorWrapper отдаёт состояния, а не
        // исключения), но если бросила — это всё равно «не дошло», а не
        // «сохранено», и молчать нельзя. Текст всё равно возьмёт failureText по
        // состоянию 'network' — message тут для полноты объекта.
        setRenameFailure({
          state: 'network',
          message: t('pages.subscription.deviceSheet.failRenameNetwork')
        })
      })
  }, [addressable, alias, draft, hwid, onGone, onRename, onRenamed, t])

  const submitForget = useCallback((): void => {
    if (busyRef.current || !addressable) return
    busyRef.current = 'forget'
    setBusy('forget')
    setForgetFailure(null)
    const seq = ++seqRef.current
    void onForget(hwid)
      .then((result) => {
        if (seqRef.current !== seq) return
        busyRef.current = null
        setBusy(null)
        if (result.state === 'ok') {
          // Устройства больше нет — лист о нём закрываем сами. Держать
          // открытыми плашки для того, чего уже нет, незачем.
          // ⚠️ Ветки 'gone' здесь нет и быть не может: см. заметку у типов —
          // «отключили» и «его и так не было» приходят одинаковым 'ok'.
          onForgotten?.(hwid)
          onOpenChange(false)
          return
        }
        setForgetFailure(result)
      })
      .catch(() => {
        if (seqRef.current !== seq) return
        busyRef.current = null
        setBusy(null)
        setForgetFailure({
          state: 'network',
          message: t('pages.subscription.deviceSheet.failForgetNetwork')
        })
      })
  }, [addressable, hwid, onForget, onForgotten, onOpenChange, t])

  // Текст отказа. Для переименования и отключения он РАЗНЫЙ там, где разная
  // правда: потерянный ответ на PATCH ничего не менял, а потерянный ответ на
  // DELETE мог и сработать — обещать «ничего не изменилось» в этом случае
  // нельзя.
  const failureText = useCallback(
    (failure: RenameFailure | RemoveFailure, kind: 'rename' | 'forget'): string => {
      // Свои слова — только там, где у главного процесса их нет или где его
      // текст сказал бы неправду. Всё остальное берём из message: он уже
      // написан для человека, и переписывать его здесь значило бы разводить
      // два текста на одну ошибку.
      if (failure.state === 'unauthorized')
        return t('pages.subscription.deviceSheet.failUnauthorized')
      if (failure.state === 'noSubscription')
        return t('pages.subscription.deviceSheet.failNoSubscription')
      // ⚠️ Потерянный ответ на ОТКЛЮЧЕНИЕ и на переименование — разная правда,
      // поэтому оба текста свои, а не общий message главного процесса
      // («Нет связи с сервером» не говорит главного). PATCH не дошёл — имя
      // точно прежнее. А DELETE мог дойти и сработать, и ответ потеряться уже
      // на обратном пути: обещать «ничего не изменилось» тут нельзя, надо
      // звать перечитать список.
      if (failure.state === 'network')
        return kind === 'forget'
          ? t('pages.subscription.deviceSheet.failForgetNetwork')
          : t('pages.subscription.deviceSheet.failRenameNetwork')
      return failure.message
    },
    [t]
  )

  // ⚠️ Лист не рисуем без снимка устройства даже при open={true}: подписывать
  // нечего, а пустая панель на экране выглядит поломкой.
  if (!device) return null

  const Icon = deviceIcon(device.platform)
  const atLimit = aliasLength(draft) >= ALIAS_MAX_LENGTH

  const warningBanner = (text: string): React.ReactNode => (
    <div className="mb-4 flex gap-2 rounded-xl border border-stroke bg-card/50 px-3 py-2.5">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  )

  const failureBlock = (
    failure: RenameFailure | RemoveFailure,
    kind: 'rename' | 'forget'
  ): React.ReactNode => (
    <div className="border-t border-stroke px-3 py-2.5">
      <p className="text-xs text-destructive">{failureText(failure, kind)}</p>
      {/* Вход предлагаем кнопкой только при 'unauthorized': на остальных
          отказах она бесполезна, а человек нажмёт на неё просто потому, что
          она единственная кнопка рядом с красным текстом. */}
      {failure.state === 'unauthorized' && onSignIn && (
        <Button size="xs" variant="outline" className="mt-2" onClick={onSignIn}>
          <LogIn />
          {t('pages.subscription.deviceSheet.signIn')}
        </Button>
      )}
    </div>
  )

  // Строка факта. Не Row: Row — это кнопка, а здесь читают, а не нажимают, и
  // фокусируемая строка без действия обманывает и мышь, и клавиатуру.
  // Геометрию Row повторяем вручную — так же сделано в списке устройств
  // (pages/subscription.tsx:645).
  const fact = (label: string, value: React.ReactNode, mono = false): React.ReactNode => (
    <div className="flex min-h-10 items-center gap-2.5 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
      <span
        className={cn(
          'shrink-0 truncate text-sm text-muted-foreground',
          // Код устройства нужен, чтобы сверить железку с кабинетом или назвать
          // её поддержке, поэтому он выделяемый: глобальное user-select: none
          // (assets/main.css:574) иначе не даст его скопировать.
          mono ? 'select-text font-mono' : 'max-w-[55%]'
        )}
      >
        {value}
      </span>
    </div>
  )

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        // rounded-t-2xl — ступень «панель» по шкале радиусов (assets/main.css:264).
        className="max-h-[85vh] gap-0 overflow-y-auto rounded-t-2xl border-stroke bg-background p-0"
        onEscapeKeyDown={(event) => {
          // Escape шагает НА ОДИН уровень назад, а не закрывает весь лист:
          // выйти из переименования и потерять при этом лист — не то, чего
          // ждёшь от Escape. Пока запрос в полёте Escape не делает ничего.
          if (busyRef.current) {
            event.preventDefault()
            return
          }
          if (phase === 'rename' || phase === 'confirm-forget') {
            event.preventDefault()
            setDraft('')
            setPhase('view')
          }
        }}
      >
        <SheetHeader className="gap-1 p-4 pb-2">
          {/* pr-8 именно на этой строке, а не px/pr на самой шапке: у Radix
              кнопка закрытия висит absolute в правом верхнем углу, и длинное
              имя уезжало бы под неё. */}
          <div className="flex items-center gap-2.5 pr-8">
            <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <SheetTitle className="min-w-0 truncate text-base">{title}</SheetTitle>
          </div>
          <SheetDescription className="text-xs">{platformLine}</SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-4">
          {/* Предупреждения идут ВЫШЕ плашек: предупреждать после того, как
              человек нажал, поздно. */}
          {!addressable && warningBanner(t('pages.subscription.deviceSheet.noHwid'))}
          {missing &&
            addressable &&
            phase !== 'gone' &&
            warningBanner(t('pages.subscription.deviceSheet.missing'))}

          {phase === 'gone' ? (
            // Устройство исчезло, пока лист был открыт. Плашки убираем совсем:
            // переименовывать и отключать нечего, и единственное честное
            // действие — закрыть.
            <Group>
              <div className="px-3 py-3">
                <p className="text-sm text-foreground">
                  {t('pages.subscription.deviceSheet.goneTitle', { name: title })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('pages.subscription.deviceSheet.goneText')}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => onOpenChange(false)}
                >
                  {t('common.close')}
                </Button>
              </div>
            </Group>
          ) : (
            <>
              <Group>
                {fact(
                  t('pages.subscription.deviceSheet.app'),
                  device.app || t('pages.subscription.deviceSheet.appUnknown')
                )}
                {fact(t('pages.subscription.deviceSheet.activity'), lastSeenLine)}
                {addressable &&
                  fact(
                    t('pages.subscription.deviceSheet.hwid'),
                    hwid.slice(0, HWID_PREFIX_LENGTH),
                    true
                  )}
              </Group>

              {/* ПЛАШКА 1 — переименование. Отдельная Group, а не соседняя
                  строка с «Отключить»: зазор между карточками и есть та защита
                  от промаха, ради которой всё это делается. */}
              <Group>
                {phase === 'rename' ? (
                  <div className="px-3 py-3">
                    <Input
                      ref={inputRef}
                      // select-text — из-за глобального user-select: none:
                      // без него в поле нельзя выделить текст мышью.
                      className="select-text"
                      value={draft}
                      // Пока запрос в полёте поле заблокировано: второй Enter
                      // физически не может ничего отправить, а замок busyRef
                      // ловит даже то, что проскочит мимо disabled.
                      disabled={busy === 'rename'}
                      placeholder={t('pages.subscription.deviceSheet.namePlaceholder')}
                      aria-label={t('pages.subscription.deviceSheet.nameLabel')}
                      onChange={(event) => {
                        // Режем длину на вводе, а не при отправке: атрибут
                        // maxLength считает UTF-16 и на эмодзи разошёлся бы с
                        // сервером. Пробелы здесь НЕ сжимаем — иначе нельзя
                        // набрать «Мак Славы»: пробел исчезал бы под пальцами.
                        setDraft(clampAlias(event.target.value))
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          submitRename()
                          return
                        }
                        if (event.key === 'Escape') {
                          // stopPropagation обязателен: Radix слушает Escape на
                          // документе и закрыл бы весь лист вместо отмены
                          // правки.
                          event.preventDefault()
                          event.stopPropagation()
                          cancelRename()
                        }
                      }}
                    />
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {hasAlias
                        ? t('pages.subscription.deviceSheet.nameHintClear')
                        : t('pages.subscription.deviceSheet.nameHint')}
                    </p>
                    {/* Предел показываем только когда в него уже уткнулись:
                        постоянный счётчик на поле из трёх слов — лишний шум. */}
                    {atLimit && (
                      <p className="mt-1 text-xs text-warning">
                        {t('pages.subscription.deviceSheet.nameAtLimit', {
                          max: ALIAS_MAX_LENGTH
                        })}
                      </p>
                    )}
                    <div className="mt-2.5 flex gap-2">
                      <Button size="sm" onClick={submitRename} disabled={busy === 'rename'}>
                        {busy === 'rename'
                          ? t('pages.subscription.deviceSheet.saving')
                          : t('common.save')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelRename}
                        disabled={busy === 'rename'}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Row
                    icon={Pencil}
                    label={
                      hasAlias
                        ? t('pages.subscription.deviceSheet.rename')
                        : t('pages.subscription.deviceSheet.setName')
                    }
                    trailing="chevron"
                    // Плашка гаснет, пока открыто подтверждение отключения:
                    // убирать её нельзя — разметка прыгнула бы, и кнопка
                    // «Отключить» уехала под палец.
                    disabled={!addressable || busy !== null || phase === 'confirm-forget'}
                    onClick={startRename}
                  />
                )}
                {renameFailure && failureBlock(renameFailure, 'rename')}
              </Group>

              {/* ПЛАШКА 2 — отключение. Деструктивное, отдельной карточкой. */}
              <Group>
                {phase === 'confirm-forget' ? (
                  <div className="px-3 py-3">
                    {/* Имя в подтверждении названо обязательно: «Отключить
                        устройство?» без имени подтверждают не читая, а
                        отключается при этом не то, что человек думал. */}
                    <p className="text-sm text-foreground">
                      {t('pages.subscription.deviceSheet.forgetConfirmTitle', { name: title })}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {missing
                        ? t('pages.subscription.deviceSheet.forgetConfirmTextMissing')
                        : t('pages.subscription.deviceSheet.forgetConfirmText')}
                    </p>
                    <div className="mt-2.5 flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={submitForget}
                        disabled={busy !== null}
                      >
                        {busy === 'forget'
                          ? t('pages.subscription.deviceSheet.forgetting')
                          : t('pages.subscription.deviceSheet.forgetConfirm')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (busyRef.current) return
                          setPhase('view')
                        }}
                        disabled={busy !== null}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Row
                    icon={Unplug}
                    label={t('pages.subscription.deviceSheet.forget')}
                    trailing="chevron"
                    disabled={!addressable || busy !== null || phase === 'rename'}
                    // ⚠️ Красим через дочерние селекторы: Row задаёт своей
                    // подписи text-foreground, а иконке text-muted-foreground
                    // прямо в классе, и одиночный класс снаружи проиграл бы им
                    // по порядку в стилях. [&_span] / [&_svg] дают специфичность
                    // выше и перекрывают наверняка.
                    className={cn(
                      '[&_span]:text-destructive [&_svg]:text-destructive',
                      'hover:bg-destructive/10'
                    )}
                    onClick={() => {
                      if (busyRef.current) return
                      setRenameFailure(null)
                      setForgetFailure(null)
                      setPhase('confirm-forget')
                    }}
                  />
                )}
                {forgetFailure && failureBlock(forgetFailure, 'forget')}
              </Group>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default DeviceSheet
