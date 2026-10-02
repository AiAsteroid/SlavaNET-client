import { RefObject, useEffect, useState } from 'react'

// Прокручивается ли содержимое области, или оно помещается целиком.
//
// Нужно в двух местах — в списке серверов и в оболочке старых экранов, — и
// обязано быть одним кодом: от этого зависит, растворять ли нижний край и
// отпускать ли пружину. Разъедься две копии, и один экран стал бы растворять
// край там, где второй не растворяет.
//
// ⚠️ Это НЕ украшение. У Apple то же условие стоит в основании упругой
// прокрутки: при NSScrollView.Elasticity.automatic выход за границы по
// вертикали разрешён, только если «the content height is greater than the view
// height». Помещается — значит ни отдачи, ни растворения быть не должно.
export function useOverflowing(
  ref: RefObject<HTMLElement | null>,
  // Содержимое меняется не только от размера: приезжают узлы, раскрывается
  // раздел. Такие случаи ResizeObserver на самой области не ловит, поэтому
  // снаружи передают то, от чего содержимое зависит.
  deps: unknown[] = []
): boolean {
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const box = ref.current
    if (!box) return
    const check = (): void => setOverflowing(box.scrollHeight > box.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(box)
    // Следим и за содержимым: высота области может не меняться, а содержимое —
    // расти. Первый ребёнок здесь и есть содержимое: и карточка списка, и
    // колонка страницы лежат в области единственным узлом.
    if (box.firstElementChild) observer.observe(box.firstElementChild)
    return (): void => observer.disconnect()
    // Зависимости раскрываются из массива: правило exhaustive-deps в этом
    // проекте не подключено, глушить нечего.
  }, [ref, ...deps])

  return overflowing
}
