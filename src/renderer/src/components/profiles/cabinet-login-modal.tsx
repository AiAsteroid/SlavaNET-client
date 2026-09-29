import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SiTelegram } from 'react-icons/si'
import { Globe } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { startEmailLogin, startSubscriptionConnect, startWebsiteLogin } from '@renderer/utils/ipc'

interface Props {
  onClose: () => void
}

// Signing in to the cabinet account. E-mail comes first on purpose: Telegram
// is often unreachable where our clients are, and subscriptions are sold
// through the site, so an account there is the one thing everybody has.
const CabinetLoginModal: React.FC<Props> = ({ onClose }) => {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const canSubmit = email.trim().length > 3 && password.length >= 8

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    // Progress and failures are reported on the card behind this dialog, so it
    // closes straight away instead of holding two places that say the same.
    onClose()
    await startEmailLogin(email.trim(), password)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-none w-100">
        <DialogHeader className="app-drag">
          <DialogTitle>{t('subscription.loginTitle')}</DialogTitle>
          <DialogDescription>{t('subscription.loginDescription')}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cabinet-email">{t('subscription.email')}</Label>
            <Input
              id="cabinet-email"
              type="email"
              autoFocus
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cabinet-password">{t('subscription.password')}</Label>
            <Input
              id="cabinet-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={!canSubmit}>
            {t('subscription.signIn')}
          </Button>
        </form>

        <button
          onClick={() => window.open('https://web.slavanet.org')}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors self-center"
        >
          {t('subscription.forgotPassword')}
        </button>

        <div className="flex items-center gap-3 py-1">
          <div className="h-px flex-1 bg-stroke" />
          <span className="text-xs text-muted-foreground">{t('subscription.or')}</span>
          <div className="h-px flex-1 bg-stroke" />
        </div>

        {/* For the person who never remembers the password but is always
            signed in to the browser. Listed before Telegram on purpose: the
            site is where subscriptions are bought, and it stays reachable
            where Telegram does not. */}
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => {
            onClose()
            void startWebsiteLogin()
          }}
        >
          <Globe className="size-4" />
          {t('subscription.signInWebsite')}
        </Button>

        <Button
          variant="outline"
          className="gap-2"
          onClick={() => {
            onClose()
            void startSubscriptionConnect()
          }}
        >
          <SiTelegram className="size-4" />
          {t('subscription.signInTelegram')}
        </Button>

      </DialogContent>
    </Dialog>
  )
}

export default CabinetLoginModal
