// Код страны узла берётся из флаг-эмодзи в его имени, а не угадывается по
// тексту: пара региональных индикаторов однозначно кодирует ISO 3166-1 alpha-2.
// В именах нашей подписки флаг стоит первым — «🇷🇺 Россия 3», «🇵🇱 Польша БС»,
// «🇸🇪 Швеция Каскад». Прочие эмодзи под правило не попадают: у групп это 🛰️ и
// 🎲, и они остаются в подписи как были.
//
// Угадывание по названию здесь было бы хуже во всём: «США» и «Швеция» пишутся
// по-русски, список стран меняется на стороне подписки, а любая опечатка в
// словаре тихо превращалась бы в отсутствующий флаг.

/** Первый региональный индикатор, U+1F1E6 = «A». */
const REGIONAL_A = 0x1f1e6

// Вариационный селектор после пары флагов встречается редко, но встречается —
// убираем вместе с самим флагом, иначе он останется в подписи невидимым мусором.
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}️?/u

export interface SplitName {
  /** ISO 3166-1 alpha-2 в нижнем регистре; пусто, если флага в имени не было. */
  code?: string
  /** Имя без флага, со схлопнутыми пробелами. */
  label: string
}

export function splitCountryName(name: string): SplitName {
  const raw = name ?? ''
  const match = FLAG.exec(raw)
  if (!match) {
    return { label: raw.trim() }
  }

  const points = Array.from(match[0])
    .map((ch) => ch.codePointAt(0) ?? 0)
    .filter((cp) => cp >= REGIONAL_A && cp <= 0x1f1ff)
  if (points.length !== 2) {
    return { label: raw.trim() }
  }

  const code = points.map((cp) => String.fromCharCode(cp - REGIONAL_A + 97)).join('')
  const label = raw.replace(match[0], ' ').replace(/\s+/g, ' ').trim()

  // Имя из одного флага без текста оставляем узнаваемым: показывать пустую
  // строку рядом с картинкой хуже, чем код страны.
  return { code, label: label || code.toUpperCase() }
}
