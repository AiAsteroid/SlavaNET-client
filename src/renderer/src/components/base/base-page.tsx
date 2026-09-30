import { Button } from '@renderer/components/ui/button'
import { platform } from '@renderer/utils/init'
import WindowControls from '@renderer/components/window-controls'
import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'

const isMac = platform === 'darwin'

// Корневые экраны капсулы: с них уходить «назад» некуда. Всё остальное открыто
// из «Ещё» и получает кнопку возврата автоматически — раньше этот список
// перечислял страницы сайдбара, которого больше нет.
const tabPaths = new Set(['/', '/home', '/more'])

interface Props {
  title?: React.ReactNode
  header?: React.ReactNode
  children?: React.ReactNode
  contentClassName?: string
  /** Кнопка «назад». Раньше выводилась по списку «страниц сайдбара»; сайдбара нет. */
  showBackButton?: boolean
}

// Общая обёртка страниц: верхняя полоса и прокручиваемое содержимое.
//
// Высота полосы берётся из --chrome-top, а не из числа в классе. Раньше по коду
// было пять разных высот заголовка — 57, 58, 106, 108, 120, — и каждая страница
// вычитала своё значение из 100vh. Теперь высоту знает одна переменная, а
// содержимое занимает остаток через flex: ничего вычитать не нужно, и при
// изменении полосы не надо править шесть файлов.
//
// ⚠️ На macOS светофор рисует система (titleBarStyle: 'hiddenInset'), и он лежит
// ПОВЕРХ веб-содержимого в левом верхнем углу. Поэтому слева резервируется место:
// без этого заголовок и кнопка «назад» окажутся под кнопками окна. На остальных
// платформах кнопки рисуем мы сами, и они уходят вправо.
const BasePage = forwardRef<HTMLDivElement, Props>((props, ref) => {
  const navigate = useNavigate()
  const location = useLocation()
  const showBack = props.showBackButton ?? !tabPaths.has(location.pathname)

  const contentRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => {
    return contentRef.current as HTMLDivElement
  })

  return (
    <div ref={contentRef} className="w-full h-full flex flex-col min-h-0">
      <div
        className="app-drag shrink-0 flex items-center justify-between gap-2 pr-3"
        style={{
          height: 'var(--chrome-top)',
          // 84 = отступ системной группы слева (12) + её ширина (60) + воздух.
          // Замерено через AppKit на macOS 26: кружки 14 pt, шаг центров 23.
          paddingLeft: isMac ? 'var(--traffic-lights-width, 84px)' : '12px'
        }}
      >
        <div className="title flex items-center gap-1 min-w-0 text-[15px] font-semibold">
          {showBack && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="app-nodrag"
              onClick={() => navigate(-1)}
            >
              <ChevronLeft className="size-5" />
            </Button>
          )}
          <span className="truncate">{props.title}</span>
        </div>
        <div className="header app-nodrag flex gap-1 items-center shrink-0">
          {props.header}
          {!isMac && <WindowControls />}
        </div>
      </div>
      <div className={`content flex-1 min-h-0 overflow-y-auto ${props.contentClassName ?? ''}`}>
        {props.children}
      </div>
    </div>
  )
})

BasePage.displayName = 'BasePage'
export default BasePage
