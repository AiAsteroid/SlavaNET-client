import { useEffect, useState } from 'react'

// Окно на переднем плане?
//
// Нужно, чтобы не крутить непрерывную анимацию, когда на приложение не смотрят:
// кнопка подключения видна всё время, и её пульс — это непрерывная перерисовка.
//
// Слушаем focus/blur самого окна, а не `visibilitychange`: у Electron-окна
// свёрнутость и потеря фокуса — разные вещи, а нас интересует именно «на него
// сейчас смотрят». Тот же выбор и по той же причине сделан в
// pages/subscription.tsx и components/window-controls.tsx.
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())

  useEffect(() => {
    const onFocus = (): void => setFocused(true)
    const onBlur = (): void => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return (): void => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return focused
}
