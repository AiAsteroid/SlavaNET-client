import { platform } from '@renderer/utils/init'
import WindowControls from '@renderer/components/window-controls'
import TitleStrip from '@renderer/components/shell/title-strip'
import { useOverflowing } from '@renderer/hooks/use-overflowing'
import { cn } from '@renderer/lib/utils'
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

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

// Общая обёртка страниц, открытых из «Ещё».
//
// Полосу сверху рисует НЕ она сама, а общий TitleStrip — тот же, что стоит на
// трёх корневых экранах капсулы. Раньше полос было две, с разными высотами,
// кеглями и выключкой заголовка, и «единый стиль» разъезжался уже на уровне
// шапки. Теперь полоса одна, а эта обёртка добавляет к ней только кнопку
// «назад» и действия экрана.
//
// ⚠️ Низ. Плавающая капсула рисуется ВСЕГДА и на любом маршруте (App.tsx), она
// fixed и занимает нижние 84px окна. Старая обёртка про неё не знала, и на всех
// двенадцати экранах последние 96px содержимого лежали под стеклом —
// на настройках туда уходила строка с версией приложения. Резерв стоит здесь,
// в одном месте на все экраны.
//
// ⚠️ Прокрутка без полосы и с растворением нижнего края — те же правила, что у
// списка серверов (main.css, .sn-scroll и .sn-fade-bottom). Полоса прокрутки
// иначе отъедает ширину и дёргает вёрстку ровно в тот момент, когда содержимое
// переросло экран.
const BasePage = forwardRef<HTMLDivElement, Props>((props, ref) => {
  const navigate = useNavigate()
  const location = useLocation()
  const showBack = props.showBackButton ?? !tabPaths.has(location.pathname)

  const contentRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => {
    return contentRef.current as HTMLDivElement
  })

  // Растворяем край, только когда есть что прокручивать: на коротком экране
  // растворять нечего, а край бы всё равно поплыл.
  const scrollRef = useRef<HTMLDivElement>(null)
  const overflowing = useOverflowing(scrollRef, [props.children])

  // Новый экран открывается сверху. Обычно это выходит само — компонент
  // размонтируется, — но когда один компонент обслуживает два маршрута
  // (так устроена «Диагностика» внутри «Ещё»), прокрутка переживает переход,
  // и вглубь человек попадал бы в середину короткого списка.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [location.pathname])

  return (
    <div ref={contentRef} className="flex h-full min-h-0 w-full flex-col">
      <TitleStrip
        title={props.title}
        onBack={showBack ? () => navigate(-1) : undefined}
        actions={
          props.header || !isMac ? (
            <>
              {props.header}
              {!isMac && <WindowControls />}
            </>
          ) : undefined
        }
      />
      <div
        ref={scrollRef}
        className={cn(
          'content sn-scroll min-h-0 flex-1 overflow-y-auto',
          overflowing && 'sn-fade-bottom',
          props.contentClassName
        )}
        style={{
          marginBottom: 'var(--nav-gap)',
          paddingBottom: 'calc(var(--nav-space) - var(--nav-gap))'
        }}
      >
        {props.children}
      </div>
    </div>
  )
})

BasePage.displayName = 'BasePage'
export default BasePage
