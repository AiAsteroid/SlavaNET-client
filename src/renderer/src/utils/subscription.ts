// Кабинет подставляет состояние в конец названия тарифа: «SlavaNET - Active».
// Отдельного заголовка со статусом подписка пока не отдаёт, поэтому чип
// собираем разбором хвоста. Держится на договорённости о формате имени —
// когда на сервере появится свой заголовок статуса, эта функция уйдёт.
//
// Живёт в utils, а не внутри страницы: чип состояния показывают оба экрана —
// строка тарифа на главной и шапка раздела «Подписка», — и разъехавшись они
// показывали бы разное название одной и той же подписки.
export function splitTariffName(raw?: string): { name: string; status?: string } {
  const value = (raw ?? '').trim()
  if (!value) return { name: '' }
  const at = value.lastIndexOf(' - ')
  if (at <= 0) return { name: value }
  const tail = value.slice(at + 3).trim()
  // Хвостом бывает и часть названия («Тариф - Про»), поэтому за статус
  // принимаем только короткое слово без пробелов.
  if (!tail || tail.includes(' ') || tail.length > 16) return { name: value }
  return { name: value.slice(0, at).trim(), status: tail }
}

// Кабинет — наш собственный адрес, а не свойство подписки. Тот же адрес
// открывает форма входа (cabinet-login-modal.tsx).
export const CABINET_URL = 'https://web.slavanet.org'

// Адрес «страницы провайдера» из заголовка profile-web-page-url.
//
// ⚠️ Наша панель кладёт туда ССЫЛКУ ПОДПИСКИ, а не кабинет: у владельца это
// `sub.slavanet.org/<токен>`, то есть ровно тот адрес, который мы весь флоу
// входа старались не пускать в браузер. Открыть его кнопкой «Личный кабинет»
// значит и увести человека не туда, и положить токен в историю браузера,
// логи редиректов и автодополнение.
//
// Поэтому: если заголовок совпал с адресом самой подписки — считаем, что
// страницы провайдера у нас нет, и ведём в кабинет.
export function providerPage(profile?: {
  home?: string
  url?: string
}): string | undefined {
  const home = profile?.home?.trim()
  if (!home) return undefined
  const subscription = profile?.url?.trim()
  if (subscription && home === subscription) return undefined
  return home
}
