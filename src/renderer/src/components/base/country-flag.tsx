interface Props {
  /** ISO 3166-1 alpha-2, нижний регистр. */
  code?: string
  /** Сторона квадрата в пикселях. */
  size?: number
  className?: string
}

// Квадратный флаг картинкой вместо эмодзи.
//
// Эмодзи не годятся: на Windows система рисует вместо флага две буквы кода
// страны, и список серверов выглядит сломанным. Наш кабинет ушёл с эмодзи по
// этой же причине, и набор здесь тот же — Flagpack (MIT), — чтобы сайт и
// приложение показывали одно и то же.
//
// Файлы лежат в public/flags и НЕ импортируются в сборку: 258 стран это 1,1 МБ
// ради десятка узлов. Побочная польза — появится узел в новой стране, флаг
// подтянется сам, класть ничего не придётся.
//
// ⚠️ Путь относительный. В собранном приложении страница открыта по file://, и
// '/flags/ru.svg' ушёл бы в корень файловой системы, а не в ресурсы.
//
// ⚠️ Квадрат со скруглением — форма наша: файлы прямоугольные 1:1, радиус
// задаётся здесь, как в кабинете (30 % стороны).
const CountryFlag: React.FC<Props> = ({ code, size = 20, className }) => {
  if (!code || !/^[a-z]{2}$/.test(code)) return null

  return (
    <img
      src={`./flags/${code}.svg`}
      // Рядом всегда стоит название страны, поэтому картинка декоративная:
      // читалке экрана незачем произносить её отдельно.
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        flex: '0 0 auto',
        objectFit: 'cover',
        boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 14%, transparent)'
      }}
    />
  )
}

export default CountryFlag
