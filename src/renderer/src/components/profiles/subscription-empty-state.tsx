import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, PlusCircle, WifiOff } from 'lucide-react'
import { Spinner } from '@renderer/components/ui/spinner'
import { cancelSubscriptionConnect, getPendingSubscriptionConnect } from '@renderer/utils/ipc'
import { useLoginStore } from '@renderer/store/login-store'

interface Props {
  // Opens the manual link dialog — the escape hatch when Telegram is not an
  // option: no account there, a link handed over by support, a second profile.
  onManual: () => void
  // Only the home screen carries the onboarding tour anchor, so the tour does
  // not find two identical targets once this card is shown in two places.
  guideAnchor?: boolean
}

// The "no subscription yet" card. Lives in one place on purpose: it is shown
// both on the home screen and on the profiles page, and the two drifting apart
// is exactly how the old manual-only wording survived the rewrite.
const SubscriptionEmptyState: React.FC<Props> = ({ onManual, guideAnchor }) => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ConnectStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [via, setVia] = useState<ConnectRoute>('telegram')
  const [code, setCode] = useState<string | null>(null)
  // A note about an attempt that is still running — "no connection", "server
  // busy". Kept apart from `error`, which means the attempt is over.
  const [note, setNote] = useState<string | null>(null)
  const openLogin = useLoginStore((s) => s.setOpen)

  // 'done' belongs here: between it and the profile list refreshing, the card
  // would otherwise flash "no subscription yet" — the opposite of what just
  // happened.
  const busy =
    status === 'requesting' ||
    status === 'waiting' ||
    status === 'fetching' ||
    status === 'importing' ||
    status === 'done'

  useEffect(() => {
    return window.electron.ipcRenderer.on(
      'subscription-connect-status',
      (_event, payload: ConnectStatusEvent) => {
        setStatus(payload.status)
        setError(payload.status === 'failed' ? (payload.message ?? null) : null)
        setNote(payload.status === 'waiting' ? (payload.message ?? null) : null)
        if (payload.link) setLink(payload.link)
        if (payload.via) setVia(payload.via)
        if (payload.code) setCode(payload.code)
      }
    )
  }, [])

  // Progress arrives as one-off events, and this card is mounted on two
  // screens — switching between them mid-flow used to reset it to the initial
  // state while the person was still confirming in Telegram.
  useEffect(() => {
    let cancelled = false
    getPendingSubscriptionConnect()
      .then((pending) => {
        if (cancelled || !pending) return
        setStatus(pending.status)
        if (pending.link) setLink(pending.link)
        if (pending.via) setVia(pending.via)
        if (pending.code) setCode(pending.code)
      })
      .catch(() => {
        // nothing to restore
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  // The button opens the sign-in dialog rather than starting a flow directly:
  // there are two ways in now, and e-mail is the one that works where Telegram
  // does not.
  const handleConnect = (): void => {
    setError(null)
    setNote(null)
    setLink(null)
    setCode(null)
    openLogin(true)
  }

  const handleCancel = async (): Promise<void> => {
    await cancelSubscriptionConnect()
    setStatus(null)
    setError(null)
    setNote(null)
    setLink(null)
    setCode(null)
  }

  return (
    <>
      <div className="flex flex-col items-center gap-4 max-w-75 rounded-2xl border border-stroke bg-card/50 backdrop-blur-xl p-8">
      {busy ? (
        <>
          <Spinner className="size-16 text-muted-foreground" />
          <h2 className="text-xl font-bold text-foreground text-center text-balance">
            {status === 'requesting'
              ? t('pages.home.connectRequesting')
              : status === 'waiting'
                ? via === 'website'
                  ? t('pages.home.connectWaitingSite')
                  : t('pages.home.connectWaiting')
                : status === 'fetching'
                  ? t('pages.home.connectFetching')
                  : t('pages.home.connectImporting')}
          </h2>
          {status === 'waiting' && (
            <>
              <p className="text-sm font-medium text-muted-foreground text-center text-balance">
                {note ??
                  (via === 'website'
                    ? t('pages.home.connectWaitingSiteHint')
                    : t('pages.home.connectWaitingHint'))}
              </p>
              {/* The confirmation page links whatever token it is handed to
                  whoever is signed in there. Showing the same first characters
                  here is what lets the person notice a token that is not the
                  one this app just asked for. */}
              {code && (
                <div className="flex flex-col items-center gap-1">
                  <span className="text-xs text-muted-foreground">
                    {t('pages.home.connectCodeLabel')}
                  </span>
                  <span className="font-mono text-base tracking-widest text-foreground select-all">
                    {code}
                  </span>
                </div>
              )}
              {/* The browser or Telegram may fail to come to the front, or the
                  person may close it by accident — let them reopen the link. */}
              {link && (
                <button
                  onClick={() => window.open(link)}
                  className="text-xs text-foreground underline underline-offset-2 hover:opacity-80 transition-opacity"
                >
                  {via === 'website'
                    ? t('pages.home.connectOpenSite')
                    : t('pages.home.connectOpenTelegram')}
                </button>
              )}
            </>
          )}
          <button
            onClick={handleCancel}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('common.cancel')}
          </button>
        </>
      ) : (
        <>
          {status === 'failed' ? (
            <AlertCircle className="size-16 text-destructive" />
          ) : (
            <WifiOff className="size-16 text-muted-foreground" />
          )}
          <h2 className="text-xl font-bold text-foreground text-center text-balance">
            {status === 'failed' ? t('pages.home.connectFailed') : t('pages.home.connectTitle')}
          </h2>
          <p className="text-sm font-medium text-muted-foreground text-center text-balance">
            {status === 'failed' && error ? error : t('pages.home.connectDescription')}
          </p>
          <button
            onClick={handleConnect}
            data-guide={guideAnchor ? 'home-add-profile-btn' : undefined}
            className="flex items-center gap-2 rounded-xl border border-stroke bg-gradient-start-power-on/50 backdrop-blur-xl px-6 py-3 text-foreground hover:bg-gradient-start-power-on/40 transition-colors"
          >
            <PlusCircle className="size-5" />
            <span className="text-sm font-medium">
              {status === 'failed' ? t('pages.home.connectRetry') : t('pages.home.connectButton')}
            </span>
          </button>
          <button
            onClick={onManual}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
          >
            {t('pages.home.connectManual')}
          </button>
        </>
        )}
      </div>
    </>
  )
}

export default SubscriptionEmptyState
