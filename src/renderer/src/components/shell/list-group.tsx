import React, { useEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronsUpDown, CreditCard, Eye, EyeOff, ExternalLink } from 'lucide-react'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'

// Сгруппированный список в духе настроек macOS и ШЕСТЬ ФОРМ СТРОКИ, которые в
// нём встречаются. Живёт отдельным компонентом, потому что им пользуются все
// разделы приложения: разъехавшись, они сразу выглядели бы как разные
// программы.
//
// Шесть форм — не выдумка, а опись кода от 02.10.2026: 162 строки настроек, из
// них 58 с переключателем, 37 с полем, 28 действий, 15 со значением,
// 13 с сегментами, 11 с выбором из списка. Раньше строка умела только одну
// форму из шести и, будучи сама кнопкой, молча выбрасывала вложенный контрол.

// Заголовок вынесен НАД карточкой, а не внутрь неё: так работает системный
// список настроек macOS, и по нему глаз сразу отделяет разделы друг от друга,
// не читая подписей.
export const Group: React.FC<{
  title?: string
  children: React.ReactNode
  /**
   * На чём лежит карточка.
   *
   * ⚠️ В диалоге нужен 'muted'. Поверхность диалога — полупрозрачная карточка
   * поверх затемнения, и в тёмной теме она складывается почти ровно в цвет
   * фона: карточка bg-card на ней становится неразличима. На этом уже
   * обожглись со столбиком цен в окне покупки (subscription.tsx).
   */
  surface?: 'card' | 'muted'
}> = ({ title, children, surface = 'card' }) => (
  <section className="mb-4">
    {title && (
      <h2 className="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
    )}
    {/* Рамки у карточки нет: в варианте «Ступень светлее» поверхность отделяет
        от фона собственная заливка (см. «Ступень светлее» в main.css). Внутри
        остаётся только волосяной разделитель — и только МЕЖДУ строками, чтобы
        условно скрытая строка не оставляла за собой линию. */}
    <div
      className={cn(
        'hair-y overflow-hidden rounded-xl',
        surface === 'muted' ? 'bg-muted' : 'bg-card'
      )}
    >
      {children}
    </div>
  </section>
)

// Геометрия строки — одна на все шесть форм. Высота 40 базовая и 52 с второй
// строкой подписи: разъехавшись на пару пикселей, формы в одной карточке сразу
// читаются как собранные из разных мест.
const SHELL = 'flex w-full items-center gap-2.5 px-3 text-left transition-colors'
// ⚠️ min-h, а не h: у части настроек подписи длинные, и при жёсткой высоте они
// обрезались посередине слова — вместе с пояснением под ними. Пусть строка
// лучше вырастет, чем соврёт о том, что в ней написано.
const H_ONE = 'min-h-10 py-1'
const H_TWO = 'min-h-[52px] py-1.5'
// ⚠️ Кольцо фокуса именно ring-inset: карточка группы обрезает содержимое
// (overflow-hidden), и обычное системное кольцо с отступом 2px у первой и
// последней строки срезалось бы её краем.
const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary'

interface BodyProps {
  icon?: typeof CreditCard
  label: React.ReactNode
  /** Вторая строка под подписью: что делает настройка, если по имени неясно. */
  sub?: React.ReactNode
  /** Красная подпись: необратимое действие. */
  danger?: boolean
}

// Левая часть строки одинакова у всех форм: значок, подпись, пояснение.
const Body: React.FC<BodyProps> = ({ icon: Icon, label, sub, danger }) => (
  <>
    {Icon && (
      <Icon
        className={cn('size-4 shrink-0', danger ? 'text-destructive' : 'text-muted-foreground')}
        aria-hidden
      />
    )}
    <span className="min-w-0 flex-1">
      {/* Подпись переносится, но не больше двух строк: длиннее — это уже не
          подпись, а пояснение, и ему место в sub. Пояснение остаётся в одну
          строку: двухэтажные пояснения превращают список в сплошной текст. */}
      <span
        className={cn(
          'block text-sm [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden',
          danger ? 'text-destructive' : 'text-foreground'
        )}
      >
        {label}
      </span>
      {sub && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{sub}</span>}
    </span>
  </>
)

// ⚠️ value у нативной кнопки — строка формы, и без Omit наш ReactNode с ней не
// сходится: интерфейс перестаёт расширять ButtonHTMLAttributes.
export interface RowProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'>,
    BodyProps {
  /** Значение справа: остаток подписки, текущий режим, версия. */
  value?: React.ReactNode
  /** Чем строка кончается — переходом, ссылкой наружу, выбором или ничем. */
  trailing?: 'chevron' | 'external' | 'picker' | 'none'
  /** Действие выполняется: вместо правого значка крутится спиннер. */
  busy?: boolean
}

const Tail: React.FC<{ trailing: RowProps['trailing']; busy?: boolean }> = ({
  trailing,
  busy
}) =>
  busy ? (
    <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
  ) : trailing === 'chevron' ? (
    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  ) : trailing === 'external' ? (
    <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  ) : trailing === 'picker' ? (
    <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  ) : null

// ФОРМА 1 и 2 — переход и значение. Строка целиком нажимается.
//
// Всегда кнопка, даже когда ведёт наружу: у «ссылки» без href нет ни роли, ни
// клавиатурного поведения, а внешние адреса всё равно уходят в window.open —
// главный процесс перехватывает его и открывает системный браузер
// (src/main/index.ts:802).
//
// ⚠️ forwardRef и проброс props обязательны: строку режима маршрутизации Radix
// оборачивает через DropdownMenuTrigger asChild и вешает на неё свои
// обработчики и aria-атрибуты.
export const Row = React.forwardRef<HTMLButtonElement, RowProps>(
  (
    { icon, label, sub, danger, value, trailing = 'none', busy, className, ...rest },
    ref
  ) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        SHELL,
        sub ? H_TWO : H_ONE,
        'cursor-pointer hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-40',
        FOCUS,
        className
      )}
      {...rest}
    >
      <Body icon={icon} label={label} sub={sub} danger={danger} />
      {value !== undefined && (
        <span className="max-w-[48%] shrink-0 truncate text-sm text-muted-foreground">{value}</span>
      )}
      <Tail trailing={trailing} busy={busy} />
    </button>
  )
)
Row.displayName = 'Row'

// ФОРМА 3 — переключатель, 58 мест.
//
// ⚠️ Строка здесь <label>, а не <button>: вложить интерактивный контрол внутрь
// кнопки нельзя — это и невалидная разметка, и сломанная клавиатура. С label
// нажатие по всей строке переключает, и это поведение системное, а не наше.
//
// ⚠️ Если у строки есть ещё и своя кнопка (шестерёнка «настроить подробнее»),
// обернуть всё в label уже нельзя: нажатие на кнопку внутри label система
// отдаёт переключателю, и настройки открывались бы вместе с переключением.
// В этом случае строка — обычный div, а подпись связана с переключателем
// через htmlFor: нажатие по тексту по-прежнему переключает.
export const SwitchRow: React.FC<
  BodyProps & {
    /**
     * ⚠️ Допускается undefined. Почти все значения в конфиге необязательные,
     * и на девяти строках из настроек ядра тип не сходился. Приводим здесь, в
     * одном месте: иначе на каждой из 58 строк пришлось бы писать ?? false, и
     * где-нибудь это забыли бы — а undefined у Radix означает «неуправляемый
     * переключатель», то есть молча отвязанный от конфига.
     */
    checked: boolean | undefined
    onCheckedChange: (next: boolean) => void
    disabled?: boolean
    busy?: boolean
    /** Своя кнопка перед переключателем: «настроить подробнее». */
    action?: { icon: typeof CreditCard; label: string; onClick: () => void }
  }
> = ({ icon, label, sub, danger, checked, onCheckedChange, disabled, busy, action }) => {
  const id = React.useId()
  const shell = cn(
    SHELL,
    sub ? H_TWO : H_ONE,
    'hover:bg-accent/50',
    disabled && 'pointer-events-none opacity-40'
  )
  return action ? (
    <div className={shell}>
      {/* Подпись связана с переключателем вручную — см. предупреждение выше. */}
      <label htmlFor={id} className="contents cursor-pointer">
        <Body icon={icon} label={label} sub={sub} danger={danger} />
      </label>
      {busy && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
      <button
        type="button"
        onClick={action.onClick}
        aria-label={action.label}
        title={action.label}
        className={cn(
          'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg',
          'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          'outline-none focus-visible:ring-2 focus-visible:ring-primary'
        )}
      >
        <action.icon className="size-4" aria-hidden />
      </button>
      <Switch id={id} checked={!!checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  ) : (
    <label className={cn(shell, 'cursor-pointer')}>
      <Body icon={icon} label={label} sub={sub} danger={danger} />
      {busy && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
      <Switch id={id} checked={!!checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </label>
  )
}

// ФОРМА 4 — поле ввода, 37 мест.
//
// ⚠️ Кнопки «Подтвердить» рядом больше нет. Их было 23, и пятнадцать из них и
// так появлялись только при изменении поля — то есть интерфейс сам не верил,
// что она нужна. Решение владельца 02.10.2026: правка применяется по уходу из
// поля и по Enter, Escape возвращает прежнее значение.
export const FieldRow: React.FC<
  BodyProps & {
    value: string
    onCommit: (next: string) => void | Promise<unknown>
    placeholder?: string
    /** Ширина поля в px: порт и адрес просят разного места. */
    width?: number
    disabled?: boolean
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
    /**
     * Прятать значение точками, как пароль, и дать кнопку «показать».
     *
     * ⚠️ Нужно ключу внешнего контроллера. До перевода экрана на набор строк
     * он был полем type="password", и при переводе маскировка потерялась:
     * поддержка штатно просит снимок экрана настроек ядра, и ключ уходил бы
     * в тикет открытым текстом.
     */
    masked?: boolean
  }
> = ({
  icon,
  label,
  sub,
  value,
  onCommit,
  placeholder,
  width = 96,
  disabled,
  inputMode,
  masked
}) => {
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const focused = useRef(false)

  // Значение могло измениться снаружи — например, конфиг перечитали. Пока поле
  // под курсором, не трогаем: иначе правка исчезала бы из-под рук.
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  const commit = async (): Promise<void> => {
    if (draft === value) return
    setBusy(true)
    try {
      await onCommit(draft)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn(SHELL, sub ? H_TWO : H_ONE, disabled && 'pointer-events-none opacity-40')}>
      <Body icon={icon} label={label} sub={sub} />
      {busy && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
      {masked && (
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? 'Скрыть' : 'Показать'}
          aria-pressed={revealed}
          className={cn(
            'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg',
            'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-primary'
          )}
        >
          {revealed ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      )}
      <input
        value={draft}
        type={masked && !revealed ? 'password' : 'text'}
        placeholder={placeholder}
        inputMode={inputMode}
        disabled={disabled}
        style={{ width }}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false
          void commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(value)
            e.currentTarget.blur()
          }
        }}
        className={cn(
          'h-[26px] shrink-0 rounded-md bg-secondary px-2 text-right text-sm tabular-nums',
          'text-foreground placeholder:text-muted-foreground',
          'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary'
        )}
      />
    </div>
  )
}

/**
 * Длина всех подписей сегментов, после которой переключатель перестаёт
 * помещаться рядом с подписью строки и переезжает под неё.
 *
 * ⚠️ Мера нужна. На экране DNS три значения — «Fake IP», «Реальный IP» и
 * «Отключить сопоставление» — занимали почти всю ширину, и подписи строки
 * оставалось шестьдесят пикселей: «Режим сопоставления доменов» сминался в
 * три обрезанные строки. Порог в 24 символа оставляет подписи не меньше
 * половины строки на минимальном окне 420px.
 */
const SEGMENTS_INLINE_LIMIT = 24

// ФОРМА 5 — сегменты. Выбор из двух-четырёх коротких значений.
export function SegmentRow<T extends string>({
  icon,
  label,
  sub,
  value,
  options,
  onChange,
  disabled
}: BodyProps & {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}): React.JSX.Element {
  // Решает длина подписей, а не число значений: «Авто / Светлая / Тёмная»
  // прекрасно живут в строке, а два длинных имени — уже нет.
  const stacked =
    options.reduce((sum, o) => sum + o.label.length, 0) > SEGMENTS_INLINE_LIMIT

  if (stacked) {
    return (
      <div
        className={cn(
          'flex w-full flex-col gap-2 px-3 py-2.5 transition-colors',
          disabled && 'pointer-events-none opacity-40'
        )}
      >
        <div className="flex items-center gap-2.5">
          <Body icon={icon} label={label} sub={sub} />
        </div>
        <div role="radiogroup" className="flex gap-0.5 rounded-lg bg-secondary p-0.5">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              onClick={() => onChange(o.value)}
              className={cn(
                'flex-1 cursor-pointer truncate rounded-md px-2 py-1 text-xs leading-none transition-colors',
                'outline-none focus-visible:ring-2 focus-visible:ring-primary',
                o.value === value
                  ? 'bg-card font-semibold text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={cn(SHELL, sub ? H_TWO : H_ONE, disabled && 'pointer-events-none opacity-40')}>
      <Body icon={icon} label={label} sub={sub} />
      <div role="radiogroup" className="flex shrink-0 gap-0.5 rounded-lg bg-secondary p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
            className={cn(
              'cursor-pointer rounded-md px-2 py-1 text-xs leading-none transition-colors',
              'outline-none focus-visible:ring-2 focus-visible:ring-primary',
              o.value === value
                ? 'bg-card font-semibold text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ФОРМА 6 — выбор из списка, 11 мест. Значений больше, чем влезет в сегменты.
export function SelectRow<T extends string>({
  icon,
  label,
  sub,
  value,
  options,
  onChange,
  disabled
}: BodyProps & {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}): React.JSX.Element {
  const current = options.find((o) => o.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Row
          icon={icon}
          label={label}
          sub={sub}
          value={current?.label ?? value}
          trailing="picker"
          disabled={disabled}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => onChange(o.value)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
