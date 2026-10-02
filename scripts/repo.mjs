import yaml from 'yaml'
import { readFileSync } from 'fs'

// Кто мы и где лежим. Одно место на все релизные скрипты.
//
// ⚠️ Заведено 02.10.2026, потому что скрипты выпуска остались от upstream и
// указывали на coolcoala/koala-clash: ссылки на загрузку в описании релиза
// уводили НАШИХ клиентов в ЧУЖОЙ репозиторий, а объявление в Telegram звало
// туда же. Плюс имена файлов там были Koala.Clash_*, хотя electron-builder
// собирает SlavaNET_* — то есть каждая ссылка вела в никуда дважды.
//
// Адрес можно переопределить переменной окружения: форк могут переносить.
export const REPO = process.env.RELEASE_REPO || 'AiAsteroid/SlavaNET-client'
export const REPO_URL = `https://github.com/${REPO}`

// Имя продукта берём из electron-builder.yml, а не повторяем строкой: имена
// файлов релиза собирает он, и две независимые копии однажды разойдутся.
const builder = yaml.parse(readFileSync('electron-builder.yml', 'utf-8'))
export const PRODUCT = builder.productName

export const releaseAsset = (version, file) => `${REPO_URL}/releases/download/${version}/${file}`
