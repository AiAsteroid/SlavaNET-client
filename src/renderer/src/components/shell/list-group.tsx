import React from 'react'
import { ChevronRight, ChevronsUpDown, CreditCard, ExternalLink } from 'lucide-react'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'

// Сгруппированный список в духе настроек macOS. Живёт отдельным компонентом,
// потому что им пользуются два раздела — «Подписка» и «Ещё», — и разъехавшись
// они сразу выглядели бы как два разных приложения.

// Заголовок вынесен НАД карточкой, а не внутрь неё: так работает системный
// список настроек macOS, и по нему глаз сразу отделяет разделы друг от друга,
// не читая подписей.
export const Group: React.FC<{ title?: string; children: React.ReactNode }> = ({
  title,
  children
}) => (
  <section className="mb-4">
    {title && (
      <h2 className="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
    )}
    {/* divide-y вместо границы на каждой строке: разделитель появляется только
        МЕЖДУ строками, и условно скрытая строка не оставляет за собой линию. */}
    <div className="divide-y divide-stroke overflow-hidden rounded-xl border border-stroke bg-card/50 backdrop-blur-xl">
      {children}
    </div>
  </section>
)

// ⚠️ value у нативной кнопки — строка формы, и без Omit наш ReactNode с ней не
// сходится: интерфейс перестаёт расширять ButtonHTMLAttributes.
export interface RowProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  icon?: typeof CreditCard
  label: string
  /** Значение справа: остаток подписки, текущий режим. */
  value?: React.ReactNode
  /** Чем строка кончается — переходом, ссылкой наружу, выбором или ничем. */
  trailing?: 'chevron' | 'external' | 'picker' | 'none'
  /** Действие выполняется: вместо правого значка крутится спиннер. */
  busy?: boolean
}

// Строка списка. Всегда кнопка, даже когда ведёт наружу: у «ссылки» без href
// нет ни роли, ни клавиатурного поведения, а внешние адреса всё равно уходят в
// window.open — главный процесс перехватывает его и открывает системный браузер
// (src/main/index.ts:802).
//
// ⚠️ forwardRef и проброс props обязательны: строку режима маршрутизации Radix
// оборачивает через DropdownMenuTrigger asChild и вешает на неё свои
// обработчики и aria-атрибуты.
//
// ⚠️ Кольцо фокуса именно ring-inset: карточка группы обрезает содержимое
// (overflow-hidden), и обычное системное кольцо с отступом 2px у первой и
// последней строки срезалось бы её краем.
export const Row = React.forwardRef<HTMLButtonElement, RowProps>(
  ({ icon: Icon, label, value, trailing = 'none', busy, className, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        'flex h-10 w-full cursor-pointer items-center gap-2.5 px-3 text-left outline-none transition-colors',
        'hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        'disabled:pointer-events-none disabled:opacity-40',
        className
      )}
      {...rest}
    >
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
      {value !== undefined && (
        <span className="max-w-[48%] shrink-0 truncate text-sm text-muted-foreground">{value}</span>
      )}
      {busy ? (
        <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
      ) : trailing === 'chevron' ? (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : trailing === 'external' ? (
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : trailing === 'picker' ? (
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </button>
  )
)
Row.displayName = 'Row'
