import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { CreditCard, MoreHorizontal, Power } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { cn } from '@renderer/lib/utils'

// Геометрия снята по пикселям с нашей PWA
// (/root/otvet-frontend/src/components/layout/AppShell/MobileBottomNav.tsx),
// чтобы приложение и кабинет выглядели одной вещью.
//
// Радиус равен половине высоты ⇒ контур капсулы эквидистантен кромке окна и на
// прямых участках, и в закруглениях. Активный овал КОНЦЕНТРИЧЕН капсуле:
// внутренний радиус = внешний минус зазор (32 − 6 = 26). Достигается тем, что
// отступ 6 задан самой капсуле, а овал занимает пункт целиком — тогда у крайних
// пунктов зазор до кромки гарантированно тот же, а не «примерно».
// ⚠️ Высота и отступ от края ДУБЛИРУЮТ --nav-height и --nav-gap из main.css:
// отсюда их берёт разметка капсулы, оттуда — резерв под неё на страницах и
// растворение нижнего края списка серверов. Правишь здесь — правь и там, иначе
// список начнёт растворяться не там, где стоит панель.
const HEIGHT = 64
const EDGE_GAP = 20
const OVAL_GAP = 6
const RADIUS = HEIGHT / 2
const OVAL_RADIUS = RADIUS - OVAL_GAP
// ⚠️ Отличие от PWA: там капсула во всю ширину телефона, здесь окно бывает
// широким, и растянутая на 1200 px капсула с двумя пунктами выглядит пустой.
const MAX_WIDTH = 420

const BLUR = 'blur(26px) saturate(180%)'

// Разделы, которые открываются ИЗ «Ещё». Активным должен быть пункт, в раздел
// которого мы ушли: попав в настройки или диагностику, человек находится внутри
// «Ещё», а не на «Подключении». Поэтому список перечислен явно, а не выведен
// «всё, кроме /home»: тогда любой будущий экран верхнего уровня молча
// подсвечивал бы «Ещё».
const MORE_PATHS = new Set([
  '/more',
  '/settings',
  '/profiles',
  '/proxies',
  '/connections',
  '/rules',
  '/logs',
  '/mihomo',
  '/sysproxy',
  '/tun',
  '/dns',
  '/sniffer',
  '/resources'
])

// Подписка вынесена в собственный раздел по решению владельца: на главном
// экране про тариф не должно быть ничего, там кнопка и серверы. В кабинете
// подписка — тоже отдельный раздел, и приложение повторяет его состав.
const SUBSCRIPTION_PATHS = new Set(['/subscription'])

type SectionId = 'connect' | 'subscription' | 'more'

// Прозрачность капсулы — не украшение: сквозь неё видно список серверов, и по
// нему человек понимает, что список продолжается под панелью. Но в macOS есть
// «Уменьшить прозрачность», и там стекло обязано стать плотным.
//
// Проверяется из JS, а не медиа-запросом в CSS: размытие и тень задаются
// инлайновым стилем (значения сняты с эталона и живут рядом с геометрией), а
// инлайновый стиль медиа-запросом не переопределить.
const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)'

// matchMedia обёрнут: в этом окне он есть всегда, но падать из-за оформления
// панель не должна — при отказе просто остаёмся со стеклом.
function matchReducedTransparency(): MediaQueryList | null {
  try {
    return window.matchMedia(REDUCED_TRANSPARENCY)
  } catch {
    return null
  }
}

function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(() => matchReducedTransparency()?.matches ?? false)

  useEffect(() => {
    const mq = matchReducedTransparency()
    if (!mq) return undefined
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return (): void => mq.removeEventListener('change', onChange)
  }, [])

  return reduced
}

// Нижняя панель — плавающая капсула «жидкого стекла» на три пункта.
//
// Сайдбара в приложении нет: «Подключение» — это весь главный экран, а всё
// остальное собрано в «Ещё». Маршрут компонент читает сам, чтобы страницы не
// передавали в него своё состояние и не расходились с ним.
const BottomNav: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const reduced = useReducedTransparency()
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([])

  // Сравнивается ПЕРВЫЙ сегмент пути: вложенные экраны вроде /settings/whatever
  // должны подсвечивать тот же пункт, что и их корень.
  const firstSegment = `/${location.pathname.split('/')[1] ?? ''}`
  const active: SectionId = SUBSCRIPTION_PATHS.has(firstSegment)
    ? 'subscription'
    : MORE_PATHS.has(firstSegment)
      ? 'more'
      : 'connect'

  const items: { id: SectionId; path: string; label: string; Icon: typeof Power }[] = [
    { id: 'connect', path: '/home', label: t('shell.navConnect'), Icon: Power },
    {
      id: 'subscription',
      path: '/subscription',
      label: t('shell.navSubscription'),
      Icon: CreditCard
    },
    { id: 'more', path: '/more', label: t('shell.navMore'), Icon: MoreHorizontal }
  ]

  // Стрелками ходят по вкладкам — это ожидаемое поведение role="tablist".
  // Без этого с клавиатуры до второго пункта не добраться вовсе: у неактивной
  // вкладки tabIndex = −1, как и требует тот же паттерн, и Tab её пропускает.
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
    navigate(items[next].path)
    tabsRef.current[next]?.focus()
  }

  return (
    <nav
      role="tablist"
      aria-label={t('shell.navLabel')}
      className={cn(
        // fixed, а не absolute: якорем должна быть видимая область окна, а не
        // растущая по содержимому оболочка.
        'app-nodrag fixed z-50 flex items-center',
        // Акцент держим в переменной: он разный в темноте и на шампани, а
        // ниже он нужен и овалу, и кольцу фокуса.
        '[--sn-accent:#2563eb] dark:[--sn-accent:#3b82f6]',
        // Текст активной вкладки — отдельным тоном, светлее заливки овала.
        // Стекло капсулы в варианте «Ступень светлее» само стало светлее, и
        // #3b82f6 на нём даёт 11-му кеглю около 3:1. Овал при этом остаётся на
        // чистом акценте: его оттенок менять незачем, он не текст.
        '[--sn-accent-ink:#2563eb] dark:[--sn-accent-ink:#6ba5fb]',
        // ⚠️ Прозрачность ступенями Tailwind (70), а не произвольной долей:
        // произвольные доли этот проект уже терял молча при сборке.
        // В темноте под стеклом стоит ПЛИТКА (--secondary), а не карточка:
        // капсула лежит поверх карточек списка, и чтобы читаться над ними, она
        // обязана быть ступенью выше них, а не вровень.
        reduced ? 'bg-card' : 'bg-white/70 dark:bg-secondary/70'
      )}
      style={{
        left: EDGE_GAP,
        right: EDGE_GAP,
        bottom: EDGE_GAP,
        maxWidth: MAX_WIDTH,
        marginInline: 'auto',
        height: HEIGHT,
        borderRadius: RADIUS,
        padding: OVAL_GAP,
        // Сброс вниз, светлая кромка сверху и волосяной край по всему овалу:
        // без края стекло сливается с карточкой, которая под него заезжает.
        boxShadow:
          '0 10px 34px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.14), inset 0 0 0 var(--hairline) rgb(124 140 170 / 18%)',
        // ⚠️ Префиксный вариант обязателен: на WebKit без него стекла не будет
        // вовсе, панель станет просто полупрозрачным пятном.
        ...(reduced
          ? {}
          : { WebkitBackdropFilter: BLUR, backdropFilter: BLUR })
      }}
    >
      {items.map((item, index) => {
        const isActive = item.id === active
        return (
          <button
            key={item.id}
            ref={(el) => {
              tabsRef.current[index] = el
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => navigate(item.path)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              'relative flex h-full flex-1 cursor-pointer flex-col items-center justify-center gap-[3px] outline-none transition-colors duration-200',
              'focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)]',
              isActive
                ? 'text-[color:var(--sn-accent-ink)]'
                : 'text-muted-foreground hover:text-foreground'
            )}
            style={{ borderRadius: OVAL_RADIUS }}
          >
            {isActive && (
              // Овал не перерисовывается на новом месте, а переезжает: layoutId
              // сохраняет ту же сущность между пунктами, и пружина показывает
              // направление перехода.
              <motion.span
                layoutId="bottom-nav-active"
                className="absolute inset-0"
                style={{
                  borderRadius: OVAL_RADIUS,
                  background: 'color-mix(in oklab, var(--sn-accent) 16%, transparent)'
                }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            )}
            <item.Icon className="relative z-10 size-6" aria-hidden />
            <span className="relative z-10 whitespace-nowrap text-[11px] font-medium leading-none">
              {item.label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

export default BottomNav
