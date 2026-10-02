import BrandMark from '@renderer/components/base/brand-mark'
import { useWindowFocused } from '@renderer/hooks/use-window-focused'
import { cn } from '@renderer/lib/utils'

// Кнопка подключения: знак SlavaNET, свет изнутри, кольцо-орбита снаружи.
// Концепт «Г2 · Волна», выбран владельцем 02.10.2026.
//
// Было: круг заливался плотным зелёным, внутри менялись две пиктограммы из
// lucide (питание/пауза), в переходе крутилась дуга за 1.1 с, а под кнопкой
// лежал внешний ореол. Три состояния выражались тремя не связанными между собой
// приёмами, и переход между ними был сменой механизма, а не величины.
//
// Стало: плашка нейтральна всегда, а состояние рассказывают три вещи, и все три
// — про один и тот же свет:
//   • сам знак разгорается (серый → брендовый неон);
//   • от него внутри диска идёт градиент из центра наружу, и по нему расходится
//     волна;
//   • снаружи кольцо: нет его — выключено, бежит дуга — переход, замкнуто со
//     светлым сегментом на орбите — работает.
//
// ⚠️ Заливать круг зелёным нельзя: знак внутри плотной заливки не читается, и
// ради контраста его пришлось бы делать тёмным — то есть ровно не светящимся.
// Свет идёт ОТ знака, поэтому цветной здесь он, а не плашка.
//
// ⚠️ Пиктограммы «пауза» больше нет: во включённом состоянии знак горит, и это
// и есть «идёт, нажми чтобы выключить». Вся разметка и вся анимация — в
// assets/main.css, блок «Кнопка подключения».

/** Состояние подключения — именно подключения, а не доступности кнопки. */
export type PowerState = 'off' | 'connecting' | 'on' | 'disconnecting'

interface Props {
  state: PowerState
  /** Нажать нельзя. Состояние при этом продолжает говорить правду. */
  disabled?: boolean
  onToggle: () => void
  ariaLabel: string
}

const PowerButton: React.FC<Props> = ({ state, disabled = false, onToggle, ariaLabel }) => {
  const focused = useWindowFocused()
  const busy = state === 'connecting' || state === 'disconnecting'

  return (
    <button
      type="button"
      // В переходе кнопка занята: второе нажатие посреди подключения ядру
      // ничего хорошего не делает. Это поведение было и до переделки.
      disabled={disabled || busy}
      onClick={onToggle}
      data-guide="home-power-toggle"
      data-state={state}
      // ⚠️ Анимация ставится на паузу, когда окно не на переднем плане.
      // Именно паузой, а не снятием: `animation: none` вернуло бы нас в нулевой
      // кадр, и при возврате к окну свет дёрнулся бы. На паузе кадр стоит,
      // перерисовки нет, а продолжится всё с того же места.
      data-still={focused ? undefined : ''}
      aria-pressed={state === 'on'}
      aria-busy={busy}
      aria-label={ariaLabel}
      className={cn(
        'sn-power relative mt-1 grid size-[152px] cursor-pointer place-items-center',
        'rounded-full outline-none transition-transform active:scale-95',
        'focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-transparent',
        'disabled:cursor-default disabled:opacity-60',
        // В переходе кнопка отключена, но гасить её не надо: там как раз и
        // происходит всё интересное.
        busy && 'disabled:opacity-100'
      )}
    >
      <span className="sn-power-plate" />
      <span className="sn-power-core" />
      <span className="sn-power-wave">
        <i />
      </span>
      {/* Кольцо шире плашки и потому живёт в своём слое. pathLength=100
          нормирует длину пути: штрих задаётся в процентах, и его не надо
          пересчитывать под радиус. */}
      <svg className="sn-power-ring" viewBox="0 0 100 100" aria-hidden>
        <circle className="sn-power-track" cx="50" cy="50" r="49" />
        <circle className="sn-power-arc" cx="50" cy="50" r="49" pathLength={100} />
      </svg>
      <BrandMark className="sn-power-mark" />
    </button>
  )
}

export default PowerButton
