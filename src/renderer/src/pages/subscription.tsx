import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { AppWindow, CalendarClock, Gauge, HeadsetIcon, InfinityIcon, RefreshCcw } from 'lucide-react'
import TitleStrip from '@renderer/components/shell/title-strip'
import { Group, Row } from '@renderer/components/shell/list-group'
import SubscriptionEmptyState from '@renderer/components/profiles/subscription-empty-state'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { calcTraffic } from '@renderer/utils/calc'
import { cn } from '@renderer/lib/utils'

// Кабинет подставляет состояние в конец названия тарифа: «SlavaNET - Active».
// Отдельного заголовка со статусом подписка пока не отдаёт, поэтому чип
// собираем разбором хвоста. Держится на договорённости о формате имени —
// когда на сервере появится свой заголовок статуса, эта функция уйдёт.
function splitTariffName(raw?: string): { name: string; status?: string } {
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

const Subscription: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { profileConfig, addProfileItem } = useProfileConfig()
  const [updating, setUpdating] = useState(false)

  const currentProfile = useMemo(() => {
    if (!profileConfig?.current || !profileConfig?.items) return null
    return profileConfig.items.find((item) => item.id === profileConfig.current) ?? null
  }, [profileConfig])

  const hasProfiles = (profileConfig?.items?.length ?? 0) > 0

  const extra = currentProfile?.extra
  const total = extra?.total ?? 0
  const used = (extra?.upload ?? 0) + (extra?.download ?? 0)
  const unlimited = total <= 0
  const expireAt = extra?.expire ?? 0

  const { daysRemaining, isExpired } = useMemo(() => {
    if (expireAt <= 0) return { daysRemaining: 0, isExpired: false }
    const at = dayjs.unix(expireAt)
    return { daysRemaining: Math.max(0, at.diff(dayjs(), 'day')), isExpired: at.isBefore(dayjs()) }
  }, [expireAt])

  // Доля показывается только когда есть от чего считать. При безлимите полоса
  // была бы ложью: делить не на что, а пустая шкала читается как «трафик
  // кончился».
  const usedShare = unlimited ? 0 : Math.min(100, Math.round((used / total) * 100))
  const shareColor =
    usedShare >= 90 ? 'bg-destructive' : usedShare >= 70 ? 'bg-warning' : 'bg-primary'

  const { name, status } = splitTariffName(currentProfile?.name)
  const cabinetUrl = currentProfile?.home
  const supportUrl = currentProfile?.supportUrl
  const canUpdate = !!currentProfile && currentProfile.type === 'remote'

  const onUpdate = async (): Promise<void> => {
    if (!currentProfile || updating) return
    setUpdating(true)
    try {
      await addProfileItem(currentProfile)
    } finally {
      setUpdating(false)
    }
  }

  if (!hasProfiles) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <TitleStrip title={t('pages.subscription.title')} />
        <div className="flex flex-1 items-center justify-center px-5 pb-(--nav-space)">
          <SubscriptionEmptyState onManual={() => navigate('/profiles')} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <TitleStrip title={t('pages.subscription.title')} />

      <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-(--nav-space)">
        {/* Карточка тарифа. Крупная цифра — это то, ради чего сюда заходят:
            при лимите остаток трафика, при безлимите — дни. Второе число
            уходит в подпись, чтобы взгляд не выбирал между двумя главными. */}
        <section className="mb-4 rounded-2xl border border-stroke bg-card/50 p-4 backdrop-blur-xl">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-foreground">
                  {name || t('pages.more.subscription.none')}
                </h2>
                {status && !isExpired && (
                  <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                    {status}
                  </span>
                )}
                {isExpired && (
                  <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                    {t('pages.more.subscription.expired')}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {expireAt > 0
                  ? t('pages.subscription.until', { date: dayjs.unix(expireAt).format('L') })
                  : t('pages.home.never')}
              </p>
            </div>

            <div className="shrink-0 text-right">
              <div className="flex items-baseline justify-end gap-1 text-2xl font-semibold tabular-nums text-foreground">
                {unlimited ? (
                  <InfinityIcon className="size-6" aria-hidden />
                ) : (
                  calcTraffic(Math.max(0, total - used))
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {unlimited
                  ? t('pages.subscription.unlimited')
                  : t('pages.subscription.trafficLeft')}
              </p>
            </div>
          </div>

          {/* Полоса только при лимите — см. комментарий к usedShare. */}
          {!unlimited && (
            <div className="mt-3">
              <div className="h-1 overflow-hidden rounded-full bg-stroke">
                <div
                  className={cn('h-full rounded-full transition-all', shareColor)}
                  style={{ width: `${Math.max(1, usedShare)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('pages.subscription.trafficOf', {
                  used: calcTraffic(used),
                  total: calcTraffic(total)
                })}
              </p>
            </div>
          )}
        </section>

        <Group title={t('pages.subscription.groupDetails')}>
          <Row
            icon={Gauge}
            label={t('pages.subscription.traffic')}
            value={unlimited ? t('pages.subscription.unlimited') : calcTraffic(used)}
          />
          <Row
            icon={CalendarClock}
            label={t('pages.subscription.daysLeftLabel')}
            value={
              expireAt > 0
                ? t('pages.more.subscription.daysLeft', { count: daysRemaining })
                : t('pages.home.never')
            }
          />
        </Group>

        <Group title={t('pages.subscription.groupActions')}>
          <Row
            icon={RefreshCcw}
            label={t('pages.more.subscription.update')}
            disabled={!canUpdate || updating}
            busy={updating}
            onClick={onUpdate}
          />
          {cabinetUrl && (
            <Row
              icon={AppWindow}
              label={t('pages.more.subscription.cabinet')}
              trailing="external"
              title={cabinetUrl}
              onClick={() => window.open(cabinetUrl)}
            />
          )}
          {supportUrl && (
            <Row
              icon={HeadsetIcon}
              label={t('pages.more.subscription.support')}
              trailing="external"
              title={supportUrl}
              onClick={() => window.open(supportUrl)}
            />
          )}
        </Group>
      </div>
    </div>
  )
}

export default Subscription
