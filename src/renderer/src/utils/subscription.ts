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
