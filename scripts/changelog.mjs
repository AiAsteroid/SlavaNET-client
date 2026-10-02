export const extractVersionSection = (text, version) => {
  const trimmed = text.trim()
  if (!trimmed) return ''

  const lines = text.split('\n')
  const escapedVer = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headingRe = new RegExp(`^(#{1,6})\\s.*?v?${escapedVer}(?![\\w.-])`)

  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headingRe)
    if (match) {
      start = i
      level = match[1].length
      break
    }
  }

  // ⚠️ Раздела с этой версией нет — это ошибка выпуска, а не повод отдать
  // весь файл. Раньше здесь стоял возврат всего changelog, и релиз 1.0.0
  // молча получил бы в описание ВЕСЬ список изменений Koala Clash, начиная с
  // их 1.4.1, — и то же самое ушло бы объявлением в Telegram. Пусть лучше
  // сборка встанет: добавить раздел — минута, отозвать объявление — нет.
  if (start === -1) {
    throw new Error(
      `В changelog.md нет раздела для версии ${version}. ` +
        'Добавьте «## ' + version + '» с описанием изменений перед выпуском.'
    )
  }

  const boundaryRe = new RegExp(`^#{1,${level}}\\s`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (boundaryRe.test(lines[i])) {
      end = i
      break
    }
  }

  return lines.slice(start, end).join('\n').trim()
}
