import React from 'react'
import { cn } from '@renderer/lib/utils'

const colorMap = {
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-primary',
  debug: 'text-muted-foreground'
}

// Строка журнала.
//
// Карточки на каждой строке больше нет: в единой системе карточка — это
// ГРУППА строк, а не строка. Отдельная карточка на каждую запись давала
// двадцать рамок на экран и ощущение, что лог собран из несвязанных кусков.
// Теперь строки лежат на одной поверхности, разделённые волоском, и список
// читается как список.
//
// ⚠️ Волосок снизу у КАЖДОЙ строки, а не «у всех, кроме последней». Список
// виртуализован: какая строка последняя, во время отрисовки неизвестно, а
// лишний волосок перед подвалом в конце списка незаметен.
const LogItem: React.FC<ControllerLog & { index: number }> = (props) => {
  const { type, payload, time } = props
  return (
    <div className="select-text border-b-[length:var(--hairline)] border-stroke bg-card px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className={cn('text-xs font-semibold uppercase tracking-wide', colorMap[type])}>
          {type}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{time}</span>
      </div>
      {/* Тело записи — произвольный текст, в нём встречаются эмодзи-флаги, и
          подменить их картинкой нельзя: имя узла здесь не отдельное поле.
          Класс flag-emoji оставляет шрифтовую подмену. */}
      <div className="flag-emoji mt-0.5 text-sm break-words">{payload}</div>
    </div>
  )
}

export default LogItem
