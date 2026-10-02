import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Gauge } from 'lucide-react'
import ProxyName from '@renderer/components/base/proxy-name'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { useGroups } from '@renderer/hooks/use-groups'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  mihomoChangeProxy,
  mihomoCloseAllConnections,
  mihomoProxyDelay
} from '@renderer/utils/ipc'

type ProxyNode = ControllerProxiesDetail | ControllerGroupDetail

// Пружина в конце списка. Chromium внутренние области прокрутки сам НЕ
// отпружинивает — системная отдача есть только у страницы целиком, — поэтому
// делаем её руками. Решение владельца 01.10.2026.
//
// ⚠️ Это временно и привязано к версии движка. Chromium умеет упругую отдачу и
// для ВНУТРЕННИХ областей прокрутки: флаг kOverscrollEffectOnNonRootScrollers
// в cc/base/features.cc уже ENABLED_BY_DEFAULT, Chrome Platform Status заявляет
// отгрузку в 145-м. У нас Electron 37.10.3, а это Chromium 138 — отдачи ещё
// нет. Как переедем на сборку с Chromium 145 и новее, всю эту пружину надо
// СНЯТЬ и отдать движку: своя рядом с системной будет спорить.
//
// Параметры названы как у Apple (WWDC 2018, «Designing Fluid Interfaces»):
// пружина настраивается ответом и затуханием, а не длительностью, —
// «the first is damping... the second property is response».
/** Докуда список оттягивается за край, px. */
const PULL_LIMIT = 120
/** Доля колеса, уходящая в оттяжку. Меньше единицы: за краем ход тяжелее. */
const PULL_RATIO = 0.32
/** Ответ пружины, с: за сколько она в основном доходит до цели. */
const PULL_RESPONSE = 0.45
/**
 * Затухание, доля от критического. Ровно 1 — это «100 % damping» у Apple,
 * то есть БЕЗ перелёта.
 *
 * ⚠️ Было 0.69, и список перелетал край на 3px. Apple прямо не рекомендует:
 * «we recommend starting with 100% damping, or no overshoot when you're tuning
 * elastic behaviors», а перелёт оправдан, только если у самого жеста есть
 * инерция В НАПРАВЛЕНИИ движения. Здесь наоборот: возврат идёт ПРОТИВ жеста,
 * и перелёт уводил бы список за точку покоя — такого у системной отдачи нет.
 */
const PULL_DAMPING_RATIO = 1
/** Угловая частота и коэффициенты интегратора — из ответа и затухания. */
const PULL_OMEGA = (2 * Math.PI) / PULL_RESPONSE
const PULL_STIFFNESS = PULL_OMEGA * PULL_OMEGA
const PULL_DAMPING = 2 * PULL_DAMPING_RATIO * PULL_OMEGA

// Задержка у провайдерских узлов замеряется по имени провайдера, иначе ядро не
// находит узел и замер молча не происходит.
function getProviderName(proxy: ProxyNode): string | undefined {
  return 'provider-name' in proxy ? proxy['provider-name'] : undefined
}

// -1 — замера ещё не было, 0 — узел не ответил. Это разные вещи, и показывать их
// одинаково нельзя: в первом случае человеку надо нажать «обновить», во втором
// выбрать другой узел.
function lastDelay(proxy: ProxyNode): number {
  return proxy.history.length > 0 ? proxy.history[proxy.history.length - 1].delay : -1
}

function delayText(delay: number): string {
  if (delay === -1) return '—'
  if (delay === 0) return '×'
  return String(delay)
}

function delayClass(delay: number): string {
  if (delay === -1) return 'text-muted-foreground/60'
  if (delay === 0) return 'text-destructive'
  if (delay < 500) return 'text-success'
  return 'text-warning'
}

// Список серверов — главное на экране подключения.
//
// Владелец выбрал вариант «один экран» именно ради этого: узлы видно сразу, без
// захода в «Группы прокси», и они листаются. Поэтому список плоский — узлы, а не
// группы с раскрытием.
//
// ⚠️ Берётся ПЕРВАЯ группа, как это делал главный экран раньше (home.tsx:200).
// У нашей подписки она одна. Если групп несколько, сваливать их узлы в одну
// кучу нельзя: имена в разных группах повторяются, а переключение адресуется
// парой «группа + узел», и куча превратилась бы в список, где половина строк
// ведёт не туда. Вместо этого в конце появляется переход на полный экран групп.
//
// ⚠️ Массовый замер задержек сам не запускается. Узлов десятки, и на каждом
// показе экрана это десятки запросов через ядро — при каждом возврате с «Ещё».
// Показываем то, что уже лежит в history, а замер человек запускает кнопкой.
//
// Виртуализация не нужна: узлов десятки, а не тысячи.
const ServerList: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { groups, mutate } = useGroups()
  const { appConfig } = useAppConfig()
  const { autoCloseConnection = true, delayTestConcurrency = 50 } = appConfig || {}

  const firstGroup = groups?.[0]
  const nodes: ProxyNode[] = firstGroup?.all ?? []
  const hasMoreGroups = (groups?.length ?? 0) > 1

  const [switching, setSwitching] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // Растворение нижнего края включаем, только когда прокручивать ЕСТЬ что:
  // на списке из трёх узлов растворять нечего, а край бы всё равно поплыл.
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const check = (): void => setOverflowing(box.scrollHeight > box.clientHeight + 1)
    check()
    // Высота меняется и от числа узлов, и от размера окна — следим за обоими
    // концами: за самой областью и за списком внутри неё.
    const observer = new ResizeObserver(check)
    observer.observe(box)
    if (listRef.current) observer.observe(listRef.current)
    return (): void => observer.disconnect()
  }, [nodes.length, hasMoreGroups])

  // Пружина. Прокрутку как таковую не трогаем: двигаем трансформом сам список,
  // поэтому выбор узла и замеры задержек работают как работали.
  //
  // ⚠️ Зависимость от nodes.length обязательна, пустым массивом её не заменить.
  // На холодном старте профиль читается из локального файла и приезжает РАНЬШЕ
  // узлов, которые идут по IPC к ещё поднимающемуся ядру. Поэтому первый рендер
  // уходит в ветку «список пуст», <ul> не существует, listRef пуст — и эффект с
  // пустыми зависимостями вышел бы на проверке ниже навсегда. Растворение края
  // при этом работало бы (у него зависимости есть), а пружины бы не было: после
  // запуска нет, после перехода в «Ещё» и обратно есть. Ровно то «через раз»,
  // которое невозможно поймать глазами.
  useEffect(() => {
    const box = scrollRef.current
    const list = listRef.current
    if (!box || !list) return
    // «Уменьшить движение» в системных настройках — пружины нет совсем.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    // Пружина считается каждый кадр, а не включается таймером «тишины».
    //
    // ⚠️ Так и только так. Сначала оттяжка держалась, пока идут события колеса,
    // и отпускалась через 90мс тишины — и выяснилось (владелец 02.10.2026:
    // «прокрутил, он задержался, а потом отпружинил»), что тишины после рывка
    // по трекпаду нет почти секунду: macOS досылает инерционный хвост с
    // затухающими дельтами, и каждая сбрасывала таймер. Список стоял оттянутым
    // весь хвост. Отличить инерцию от живого пальца в Chromium нечем — фазы
    // жеста в событии колеса нет. Поэтому возврат не ждёт ничего: он идёт
    // всегда, а колесо лишь подкидывает оттяжке энергии. Пока палец давит,
    // подпитка перевешивает возврат и список стоит оттянутым; как только
    // хвост начинает гаснуть, оттяжка уходит вместе с ним.
    let offset = 0
    let velocity = 0
    let input = 0
    let frame: number | null = null
    let last = 0

    const paint = (): void => {
      if (offset === 0) {
        list.style.transform = ''
        list.style.marginBottom = ''
        return
      }
      list.style.transform = `translateY(${offset.toFixed(1)}px)`
      // ⚠️ Отрицательный отступ гасит ровно то, что добавил трансформ: иначе
      // сдвинутый список меняет ДЛИНУ прокрутки, и браузер подрезает scrollTop
      // прямо под пальцем. Знак общий для обоих концов — сдвиг и отступ всегда
      // противоположны.
      list.style.marginBottom = `${(-offset).toFixed(1)}px`
    }

    const step = (now: number): void => {
      // Шаг времени ограничен сверху: окно могло уйти в фон, и один огромный
      // кадр выбросил бы пружину за пределы одним прыжком.
      const dt = Math.min(0.032, (now - last) / 1000) || 0.016
      last = now

      offset = Math.max(-PULL_LIMIT, Math.min(PULL_LIMIT, offset + input))
      input = 0

      velocity += (-PULL_STIFFNESS * offset - PULL_DAMPING * velocity) * dt
      offset += velocity * dt

      if (Math.abs(offset) < 0.4 && Math.abs(velocity) < 8) {
        offset = 0
        velocity = 0
        paint()
        frame = null
        return
      }
      paint()
      frame = requestAnimationFrame(step)
    }

    const onWheel = (e: WheelEvent): void => {
      // ⚠️ Список целиком помещается — отдачи нет вовсе. Так устроена
      // NSScrollView.Elasticity.automatic у Apple: по вертикали выход за
      // границы разрешён, только если «the content height is greater than the
      // view height» (или виден скроллер, или включён alwaysBounceVertical).
      // Без этой проверки оба края истинны одновременно, и короткий список из
      // трёх серверов начинал ездить под колесом, хотя прокручивать нечего.
      if (box.scrollHeight <= box.clientHeight + 1) return

      const atTop = box.scrollTop <= 0
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 1
      const pulling = (atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)
      // Не у края — отдаём событие обычной прокрутке. Оставшуюся оттяжку, если
      // она есть, пружина доведёт до нуля сама, мешать ей не нужно.
      if (!pulling) return

      e.preventDefault()
      // Чем дальше оттянут список, тем меньше ход от того же толчка: без этого
      // один рывок улетает в предел.
      const ease = 1 - Math.min(Math.abs(offset) / PULL_LIMIT, 0.8)
      input -= e.deltaY * PULL_RATIO * ease

      if (frame === null) {
        last = performance.now()
        frame = requestAnimationFrame(step)
      }
    }

    // passive: false обязателен — без него preventDefault молча не сработает.
    box.addEventListener('wheel', onWheel, { passive: false })
    return (): void => {
      box.removeEventListener('wheel', onWheel)
      if (frame !== null) cancelAnimationFrame(frame)
      list.style.transform = ''
      list.style.marginBottom = ''
    }
  }, [nodes.length])

  // Компонент живёт на экране, с которого легко уйти в «Ещё» посреди замера.
  // Без этой отметки завершение замера дёрнуло бы setState у размонтированного.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return (): void => {
      mountedRef.current = false
    }
  }, [])

  // Замер идёт десятками запросов, и каждый мог бы дёрнуть перерисовку списка.
  // Поэтому обновление данных придушено: задержки проявляются волнами, а не
  // перекладывают список на каждый ответ.
  const mutateThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const throttledMutate = (): void => {
    if (mutateThrottleRef.current) return
    mutateThrottleRef.current = setTimeout(() => {
      mutate()
      mutateThrottleRef.current = null
    }, 500)
  }
  useEffect(() => {
    return (): void => {
      if (mutateThrottleRef.current) clearTimeout(mutateThrottleRef.current)
    }
  }, [])

  const onSelect = async (name: string): Promise<void> => {
    if (!firstGroup || switching) return
    setSwitching(name)
    try {
      await mihomoChangeProxy(firstGroup.name, name)
      // Старые соединения продолжали бы идти через прежний узел, и человек
      // решил бы, что переключение не сработало.
      if (autoCloseConnection) {
        await mihomoCloseAllConnections(firstGroup.name)
      }
      mutate()
    } catch (e) {
      toast.error(`${e}`)
    } finally {
      if (mountedRef.current) setSwitching(null)
    }
  }

  const onRefreshDelays = async (): Promise<void> => {
    if (!firstGroup || testing || nodes.length === 0) return
    setTesting(true)
    const limit = delayTestConcurrency || 50
    const all: Promise<void>[] = []
    const running: Promise<void>[] = []
    for (const proxy of nodes) {
      const task = Promise.resolve().then(async () => {
        try {
          await mihomoProxyDelay(proxy.name, firstGroup.testUrl, getProviderName(proxy))
        } catch {
          // Узел не ответил — это и есть результат замера, он придёт нулём в
          // history. Тост на каждый мёртвый узел завалил бы экран.
        } finally {
          throttledMutate()
        }
      })
      all.push(task)
      // Окно одновременных замеров: ядро на сотне параллельных запросов
      // начинает отдавать таймауты у живых узлов.
      const slot = task.then(() => {
        running.splice(running.indexOf(slot), 1)
      })
      running.push(slot)
      if (running.length >= limit) {
        await Promise.race(running)
      }
    }
    await Promise.all(all)
    mutate()
    if (mountedRef.current) setTesting(false)
  }

  return (
    // min-h-0 обязателен: без него flex-колонка растягивается по содержимому, и
    // прокручиваться начинает весь экран вместе с кнопкой включения.
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        '[--sn-accent:#2563eb] dark:[--sn-accent:#3b82f6]',
        // Заливка выбранной строки задаётся ОТДЕЛЬНО от акцента, а не долей от
        // него. В темноте синий по тёмно-синему фону смешивается чисто, а по
        // шампани холодный синий на 20 % мутнеет до серо-лилового и перестаёт
        // читаться акцентом. Поэтому в светлой теме подмешиваем не в
        // прозрачность, а в белый: получается ясный бледно-голубой.
        '[--sn-selected:color-mix(in_oklab,#2563eb_12%,#ffffff)]',
        'dark:[--sn-selected:color-mix(in_oklab,#3b82f6_20%,transparent)]'
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 pb-1.5">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-[13px] font-semibold text-foreground">{t('connect.servers')}</span>
          {nodes.length > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground">{nodes.length}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onRefreshDelays}
          disabled={testing || nodes.length === 0}
          aria-label={t('connect.refreshDelays')}
          title={t('connect.refreshDelays')}
          aria-busy={testing}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)] disabled:pointer-events-none disabled:opacity-40"
        >
          {testing ? <Spinner className="size-3.5" /> : <Gauge className="size-3.5" />}
        </button>
      </div>

      {/* Боковых отступов у прокрутки нет намеренно: карточка списка встаёт
          ровно по краям живой строки над ней, обе на отступе страницы (px-5).
          Разъедься они на пару пикселей — экран сразу читается как собранный
          из двух разных макетов.

          Снизу область уходит под стекло капсулы, а запас под неё лежит ЗДЕСЬ, в
          отступе прокрутки, а не у страницы: иначе список обрывался бы по линейке
          перед панелью. Благодаря этому запасу долистанный до конца список всё
          равно кончается на чистом месте, а не под стеклом.

          ⚠️ Кончается область ровно на НИЖНЕЙ кромке капсулы, а не у края окна.
          Между кромкой и краем 20px, и строки там уже полностью растворены —
          но нажатия ловили бы по-прежнему, и клик у нижнего края окна молча
          переключал бы сервер. */}
      <div
        ref={scrollRef}
        className={cn(
          'sn-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain',
          overflowing && 'sn-fade-bottom'
        )}
        style={{
          marginBottom: 'var(--nav-gap)',
          paddingBottom: 'calc(var(--nav-space) - var(--nav-gap))'
        }}
      >
        {nodes.length === 0 ? (
          // Пустота без объяснения читается как поломка: строка говорит, что
          // список пуст осознанно.
          <p className="px-3 py-3 text-[13px] text-muted-foreground">{t('connect.noServers')}</p>
        ) : (
          // Список — одна карточка со сплошной заливкой и волосяными
          // разделителями, как системный список macOS. Рамки нет: поверхность
          // отделяет от фона собственный тон (см. «Ступень светлее» в main.css).
          <ul ref={listRef} className="hair-y flex flex-col overflow-hidden rounded-xl bg-card">
            {nodes.map((proxy) => {
              const selected = firstGroup?.now === proxy.name
              const delay = lastDelay(proxy)
              return (
                <li key={proxy.name}>
                  <button
                    type="button"
                    onClick={() => onSelect(proxy.name)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'flex h-11 w-full cursor-pointer items-center gap-2.5 px-2.5 text-left outline-none transition-colors',
                      // ⚠️ Кольцо фокуса внутрь: карточка обрезает содержимое
                      // (overflow-hidden), и у первой и последней строки
                      // обычное кольцо срезалось бы её краем.
                      'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--sn-accent)]',
                      selected ? 'text-foreground' : 'hover:bg-accent'
                    )}
                    style={selected ? { background: 'var(--sn-selected)' } : undefined}
                  >
                    {/* Галочки нет намеренно: выбранный узел обозначает сама
                        подсветка строки. Слот под значок тоже убран — иначе
                        все имена стояли бы с отступом ради метки, которой нет. */}
                    <ProxyName
                      name={proxy.name}
                      size={18}
                      className={cn('min-w-0 flex-1 text-[13px]', selected && 'font-medium')}
                    />
                    {/* Ожидание показываем НА МЕСТЕ задержки, а не слева: пока
                        узел переключается, его задержка всё равно не значит
                        ничего, зато строка не дёргается. */}
                    <span
                      className={cn(
                        'flex w-12 shrink-0 items-center justify-end font-mono text-[11px] tabular-nums',
                        delayClass(delay)
                      )}
                    >
                      {switching === proxy.name ? <Spinner className="size-3.5" /> : delayText(delay)}
                    </span>
                  </button>
                </li>
              )
            })}
            {hasMoreGroups && (
              <li>
                <button
                  type="button"
                  onClick={() => navigate('/proxies')}
                  className="flex h-11 w-full cursor-pointer items-center gap-2.5 px-2.5 text-left text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--sn-accent)]"
                >
                  <span className="w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {t('connect.allServers')}
                  </span>
                  <ChevronRight className="size-4 shrink-0" />
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}

export default ServerList
