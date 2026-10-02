// Служебные настройки, открывающиеся семью нажатиями по версии.
//
// Флаг живёт в sessionStorage, а не в состоянии экрана: с переходом на
// вариант «как в системных настройках» разделы уехали на свои страницы, и
// состояние компонента до них больше не доезжает. Сессия — верный срок
// жизни: перезапустил приложение, и служебное снова спрятано.
const KEY = 'slavanet.hiddenSettings'

export function hiddenSettingsUnlocked(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    // Приватное окно или запрет на хранилище — считаем, что заперто.
    return false
  }
}

export function unlockHiddenSettings(): void {
  try {
    sessionStorage.setItem(KEY, '1')
  } catch {
    // Не сохранилось — флаг проживёт до ухода с экрана. Это приемлемо:
    // служебные настройки нужны на один разбор обращения.
  }
}
