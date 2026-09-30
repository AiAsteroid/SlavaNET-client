import React from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { platform } from '@renderer/utils/init'

const isMac = platform === 'darwin'

interface Props {
  /** Заголовок по центру полосы. Без него полоса остаётся пустой — только перетаскивание. */
  title?: string
  /** Кнопка «назад» слева. Нет обработчика — нет и кнопки. */
  onBack?: () => void
}

// Верхняя полоса окна: место, за которое окно тащат, и заголовок экрана.
//
// Фон намеренно прозрачный: за окном лежит нативный материал, и своя заливка
// поверх него дала бы вторую, чуть иную плоскость на месте единого стекла.
//
// ⚠️ Светофор на macOS больше НЕ наш. Раньше кнопки окна рисовал
// window-controls.tsx (App.tsx:266-270), теперь их рисует система
// (titleBarStyle: 'hiddenInset') ПОВЕРХ веб-содержимого в левом верхнем углу.
// Поэтому слева резервируется место: без него заголовок и «назад» окажутся под
// кнопками окна, и по ним нельзя будет попасть. На остальных платформах кнопки
// уходят вправо, и слева хватает обычных 12 px.
//
// ⚠️ Ширина резерва берётся из --traffic-lights-width с запасным значением: если
// переменную ещё не объявили, полоса всё равно не съезжает под светофор.
//
// ⚠️ Перетаскивает ВСЯ площадь полосы (app-drag), поэтому каждая кнопка внутри
// обязана быть app-nodrag — иначе клик по ней система заберёт себе как начало
// перетаскивания окна, и кнопка перестанет нажиматься.
const TitleStrip: React.FC<Props> = ({ title, onBack }) => {
  const { t } = useTranslation()

  return (
    <div
      className="app-drag relative z-20 flex shrink-0 items-center"
      style={{
        height: 'var(--chrome-top, 52px)',
        paddingLeft: isMac ? 'var(--traffic-lights-width, 84px)' : '12px',
        paddingRight: '12px'
      }}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={t('shell.back')}
          title={t('shell.back')}
          className="app-nodrag relative z-10 flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-stroke"
        >
          <ChevronLeft className="size-4.5" />
        </button>
      )}
      {title && (
        // Заголовок центрируется по всей полосе, а не по остатку после кнопки:
        // иначе он дёргался бы влево-вправо при появлении «назад».
        // pointer-events-none — чтобы текст не отбирал у полосы перетаскивание.
        <span className="pointer-events-none absolute left-1/2 max-w-[60%] -translate-x-1/2 truncate text-[13px] font-semibold text-foreground">
          {title}
        </span>
      )}
    </div>
  )
}

export default TitleStrip
