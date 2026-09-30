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
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1">
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
        {nodes.length === 0 ? (
          // Пустота без объяснения читается как поломка: строка говорит, что
          // список пуст осознанно.
          <p className="px-1 py-3 text-[13px] text-muted-foreground">{t('connect.noServers')}</p>
        ) : (
          <ul className="flex flex-col">
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
                      'flex h-11 w-full cursor-pointer items-center gap-2 rounded-[10px] px-2 text-left outline-none transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)]',
                      selected ? 'text-foreground' : 'hover:bg-accent/50'
                    )}
                    style={
                      selected
                        ? { background: 'var(--sn-selected)' }
                        : undefined
                    }
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
                  className="flex h-11 w-full cursor-pointer items-center gap-2 rounded-[10px] px-2 text-left text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--sn-accent)]"
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
