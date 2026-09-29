import { create } from 'zustand'

// The sign-in dialog is opened from three places that do not know about each
// other: the empty-state card, the "+" menu on the profiles page, and a
// slavanet://connect link clicked on the website. Keeping the flag here lets
// the dialog live once, at the top of the app, instead of once per screen.
interface LoginStore {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useLoginStore = create<LoginStore>((set) => ({
  open: false,
  setOpen: (open): void => set({ open })
}))

let attached = false

// Main asks for the dialog when a website link wakes the app and there is no
// stored session to use.
export function attachLoginStore(): () => void {
  if (attached) return () => undefined
  attached = true
  const off = window.electron.ipcRenderer.on('open-subscription-login', () => {
    useLoginStore.getState().setOpen(true)
  })
  return (): void => {
    attached = false
    off()
  }
}
