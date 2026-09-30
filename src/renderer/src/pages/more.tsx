import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'
import {
  ChevronRight,
  ChevronsUpDown,
  Code,
  CreditCard,
  ExternalLink,
  Github,
  Globe,
  Route,
  SlidersHorizontal
} from 'lucide-react'
import TitleStrip from '@renderer/components/shell/title-strip'
import { Spinner } from '@renderer/components/ui/spinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { useGroups } from '@renderer/hooks/use-groups'
import { getVersion, mihomoCloseAllConnections, patchMihomoConfig } from '@renderer/utils/ipc'
import { cn } from '@renderer/lib/utils'

// Кабинет — наш собственный адрес, а не свойство подписки. У профиля может быть
// свой home (его подставляет подписка), но если его нет, человеку всё равно
// нужно куда-то попасть за оплатой: ссылка на кабинет остаётся всегда.
// Тот же адрес открывает cabinet-login-modal.tsx:81.

// ⚠️ GPL-3.0: раздавая сборку, мы обязаны дать получателю исходники нашей версии.
// Эта ссылка — самый простой способ исполнить требование, удалять её нельзя.
const REPO_URL = 'https://github.com/AiAsteroid/SlavaNET-client'

// Технические экраны. Раньше половина из них висела в сайдбаре у всех на виду,
// хотя нужны они одному оператору поддержки из ста запусков. Здесь они лежат
// вторым уровнем: список плоский и без иконок — это не разделы, а инструменты,
// и подбирать значок каждому означало бы делать вид, что они равны настройкам.
const DIAGNOSTICS: { path: string; labelKey: string }[] = [
  { path: '/connections', labelKey: 'pages.more.diagnostics.connections' },
  { path: '/rules', labelKey: 'pages.more.diagnostics.rules' },
  { path: '/logs', labelKey: 'pages.more.diagnostics.logs' },
  { path: '/mihomo', labelKey: 'pages.more.diagnostics.core' },
  { path: '/sysproxy', labelKey: 'pages.more.diagnostics.sysproxy' },
  { path: '/tun', labelKey: 'pages.more.diagnostics.tun' },
  { path: '/dns', labelKey: 'pages.more.diagnostics.dns' },
  { path: '/sniffer', labelKey: 'pages.more.diagnostics.sniffer' },
  { path: '/resources', labelKey: 'pages.more.diagnostics.resources' }
]

const ROUTING_MODES: { value: OutboundMode; labelKey: string }[] = [
  { value: 'rule', labelKey: 'pages.more.app.routingRule' },
  { value: 'global', labelKey: 'pages.more.app.routingGlobal' },
  { value: 'direct', labelKey: 'pages.more.app.routingDirect' }
]

// Группа строк. Заголовок вынесен НАД карточкой, а не внутрь неё: так работает
// системный список настроек macOS, и по нему глаз сразу отделяет разделы друг от
// друга, не читая подписей.
const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="mb-4">
    <h2 className="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {title}
    </h2>
    {/* divide-y вместо границы на каждой строке: разделитель появляется только
        МЕЖДУ строками, и условно скрытая строка не оставляет за собой линию. */}
    <div className="divide-y divide-stroke overflow-hidden rounded-xl border border-stroke bg-card/50 backdrop-blur-xl">
      {children}
    </div>
  </section>
)

// ⚠️ value у нативной кнопки — строка формы, и без Omit наш ReactNode с ней не
// сходится: интерфейс перестаёт расширять ButtonHTMLAttributes.
interface RowProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  icon?: typeof CreditCard
  label: string
  /** Значение справа: остаток подписки, текущий режим. */
  value?: React.ReactNode
  /** Чем строка кончается — переходом, ссылкой наружу, выбором или ничем. */
  trailing?: 'chevron' | 'external' | 'picker' | 'none'
  /** Действие выполняется: вместо правого значка крутится спиннер. */
  busy?: boolean
}

// Строка списка. Всегда кнопка, даже когда ведёт наружу: у «ссылки» без href
// нет ни роли, ни клавиатурного поведения, а внешние адреса всё равно уходят в
// window.open — главный процесс перехватывает его и открывает системный браузер
// (src/main/index.ts:802).
//
// ⚠️ forwardRef и проброс props обязательны: строку режима маршрутизации Radix
// оборачивает через DropdownMenuTrigger asChild и вешает на неё свои
// обработчики и aria-атрибуты.
//
// ⚠️ Кольцо фокуса именно ring-inset: карточка группы обрезает содержимое
// (overflow-hidden), и обычное системное кольцо с отступом 2px у первой и
// последней строки срезалось бы её краем.
const Row = React.forwardRef<HTMLButtonElement, RowProps>(
  ({ icon: Icon, label, value, trailing = 'none', busy, className, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        'flex h-10 w-full cursor-pointer items-center gap-2.5 px-3 text-left outline-none transition-colors',
        'hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        'disabled:pointer-events-none disabled:opacity-40',
        className
      )}
      {...rest}
    >
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
      {value !== undefined && (
        <span className="max-w-[48%] shrink-0 truncate text-sm text-muted-foreground">{value}</span>
      )}
      {busy ? (
        <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
      ) : trailing === 'chevron' ? (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : trailing === 'external' ? (
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : trailing === 'picker' ? (
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </button>
  )
)
Row.displayName = 'Row'

type Level = 'root' | 'diagnostics'

// Раздел «Ещё» — единственная дверь ко всему, что ушло с главного экрана.
//
// Диагностика сделана состоянием ВНУТРИ страницы, а не отдельным маршрутом:
// иначе на техническом экране капсула подсвечивала бы «Ещё» через список
// MORE_PATHS (bottom-nav.tsx:33), а кнопка «назад» вела бы через историю
// браузера — и возврат с /logs на второй уровень стал бы невозможен, потому что
// самого второго уровня в истории нет.
const More: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { appConfig } = useAppConfig()
  const { autoCloseConnection = true } = appConfig || {}
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { mode } = controledMihomoConfig || {}
  const { profileConfig } = useProfileConfig()
  const { mutate: mutateGroups } = useGroups()
  const { data: version } = useSWR('getVersion', getVersion)

  const [level, setLevel] = useState<Level>('root')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Прокрутка принадлежит внешнему контейнеру, а содержимое в нём подменяется.
  // Без сброса вход в диагностику из прокрутанного низа списка открывал бы её
  // уже прокрученной — на экране оказалась бы середина короткого списка.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [level])

  const currentProfile =
    profileConfig?.items?.find((item) => item.id === profileConfig?.current) ?? null
  const hasProfiles = (profileConfig?.items?.length ?? 0) > 0

  // Подписка вправе запретить ручное переключение режима: раньше это делал
  // app-sidebar.tsx:96, который просто не показывал переключатель при
  // globalMode === false. Условие перенесено как было — иначе клиент с таким
  // профилем получил бы кнопку, которой у него не должно быть.
  const routingAllowed = hasProfiles && currentProfile?.globalMode !== false


  const onChangeMode = async (next: OutboundMode): Promise<void> => {
    if (next === mode) return
    await patchControledMihomoConfig({ mode: next })
    await patchMihomoConfig({ mode: next })
    // Старые соединения продолжали бы идти по прежним правилам, и человек
    // решил бы, что режим не переключился.
    if (autoCloseConnection) {
      await mihomoCloseAllConnections()
    }
    mutateGroups()
    window.electron.ipcRenderer.send('updateTrayMenu')
  }

  const modeLabel = ROUTING_MODES.find((m) => m.value === mode)?.labelKey

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <TitleStrip
        title={level === 'root' ? t('pages.more.title') : t('pages.more.diagnostics.title')}
        onBack={level === 'root' ? undefined : (): void => setLevel('root')}
      />
      {/* Отступ снизу — под плавающую капсулу: она лежит поверх содержимого
          (position: fixed), и без резерва последние строки списка оказались бы
          под стеклом, а доскроллить до них было бы нельзя. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-[var(--nav-space)]"
      >
        {/* key переигрывает появление при смене уровня: направление сдвига
            показывает, вглубь мы ушли или вернулись. */}
        <div
          key={level}
          className={cn(
            'animate-in fade-in-0 duration-200 motion-reduce:animate-none',
            level === 'root' ? 'slide-in-from-left-2' : 'slide-in-from-right-2'
          )}
        >
          {level === 'root' ? (
            <>
              {/* Раздел «Подписка» переехал в собственную вкладку капсулы
                  (pages/subscription.tsx, решение владельца 30.09.2026).
                  Дублировать его здесь значит держать два места, которые
                  разъедутся при первой же правке. */}
              <Group title={t('pages.more.groups.app')}>
                <Row
                  icon={SlidersHorizontal}
                  label={t('pages.more.app.settings')}
                  trailing="chevron"
                  onClick={() => navigate('/settings')}
                />
                {routingAllowed && mode && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Row
                        icon={Route}
                        label={t('pages.more.app.routing')}
                        value={modeLabel ? t(modeLabel) : mode}
                        trailing="picker"
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup
                        value={mode}
                        onValueChange={(value) => onChangeMode(value as OutboundMode)}
                      >
                        {ROUTING_MODES.map((item) => (
                          <DropdownMenuRadioItem key={item.value} value={item.value}>
                            {t(item.labelKey)}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {hasProfiles && (
                  <Row
                    icon={Globe}
                    label={t('pages.more.app.servers')}
                    trailing="chevron"
                    onClick={() => navigate('/proxies')}
                  />
                )}
              </Group>

              {/* Диагностика видна всегда, в том числе без подписки: логи и
                  настройки ядра нужны ровно тогда, когда подписка не встала. */}
              <Group title={t('pages.more.groups.support')}>
                <Row
                  icon={Code}
                  label={t('pages.more.support.diagnostics')}
                  trailing="chevron"
                  onClick={() => setLevel('diagnostics')}
                />
              </Group>

              <div className="flex flex-col items-center gap-1 pb-2 text-xs text-muted-foreground">
                <span className="tabular-nums">SlavaNET {version ?? '—'}</span>
                <button
                  type="button"
                  onClick={() => window.open(REPO_URL)}
                  title={REPO_URL}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-0.5 transition-colors hover:text-foreground"
                >
                  <Github className="size-3.5" aria-hidden />
                  <span>{t('pages.more.about.sourceCode')}</span>
                </button>
              </div>
            </>
          ) : (
            <Group title={t('pages.more.diagnostics.group')}>
              {DIAGNOSTICS.map((item) => (
                <Row
                  key={item.path}
                  label={t(item.labelKey)}
                  trailing="chevron"
                  onClick={() => navigate(item.path)}
                />
              ))}
            </Group>
          )}
        </div>
      </div>
    </div>
  )
}

export default More
