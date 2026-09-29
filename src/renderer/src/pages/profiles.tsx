import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import BasePage from '@renderer/components/base/base-page'
import ProfileItem from '@renderer/components/profiles/profile-item'
import EditInfoModal from '@renderer/components/profiles/edit-info-modal'
import SubscriptionEmptyState from '@renderer/components/profiles/subscription-empty-state'
import { useLoginStore } from '@renderer/store/login-store'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { readTextFile } from '@renderer/utils/ipc'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { useTranslation } from 'react-i18next'
import { Plus, FileDown, RefreshCcw } from 'lucide-react'

const emptyItems: ProfileItem[] = []

const Profiles: React.FC = () => {
  const { t } = useTranslation()
  const {
    profileConfig,
    setProfileConfig,
    addProfileItem,
    updateProfileItem,
    removeProfileItem,
    changeCurrentProfile
  } = useProfileConfig()
  const { current, items } = profileConfig || {}
  const itemsArray = items ?? emptyItems
  const [sortedItems, setSortedItems] = useState(itemsArray)
  const [updating, setUpdating] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const openLogin = useLoginStore((s) => s.setOpen)
  const [editingItem, setEditingItem] = useState<ProfileItem | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 2
      }
    })
  )
  const pageRef = useRef<HTMLDivElement>(null)
  const dragCounterRef = useRef(0)
  const addProfileItemRef = useRef(addProfileItem)
  addProfileItemRef.current = addProfileItem
  const tRef = useRef(t)
  tRef.current = t

  const onDragEnd = async (event: DragEndEvent): Promise<void> => {
    const { active, over } = event
    if (over) {
      if (active.id !== over.id) {
        const newOrder = sortedItems.slice()
        const activeIndex = newOrder.findIndex((item) => item.id === active.id)
        const overIndex = newOrder.findIndex((item) => item.id === over.id)
        newOrder.splice(activeIndex, 1)
        newOrder.splice(overIndex, 0, itemsArray[activeIndex])
        setSortedItems(newOrder)
        await setProfileConfig({ current, items: newOrder })
      }
    }
  }

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) {
      setFileOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setFileOver(false)
    }
  }, [])

  const handleDrop = useCallback(async (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounterRef.current = 0
    setFileOver(false)
    if (event.dataTransfer?.files) {
      const file = event.dataTransfer.files[0]
      if (
        file.name.endsWith('.yml') ||
        file.name.endsWith('.yaml') ||
        file.name.endsWith('.json') ||
        file.name.endsWith('.jsonc') ||
        file.name.endsWith('.json5') ||
        file.name.endsWith('.txt')
      ) {
        try {
          const path = window.api.webUtils.getPathForFile(file)
          const content = await readTextFile(path)
          await addProfileItemRef.current({ name: file.name, type: 'local', file: content })
        } catch (e) {
          toast.error(tRef.current('pages.profiles.fileImportFailed') + e)
        }
      } else {
        toast.error(tRef.current('pages.profiles.unsupportedFileType'))
      }
    }
  }, [])

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    el.addEventListener('dragover', handleDragOver)
    el.addEventListener('dragenter', handleDragEnter)
    el.addEventListener('dragleave', handleDragLeave)
    el.addEventListener('drop', handleDrop)
    return (): void => {
      el.removeEventListener('dragover', handleDragOver)
      el.removeEventListener('dragenter', handleDragEnter)
      el.removeEventListener('dragleave', handleDragLeave)
      el.removeEventListener('drop', handleDrop)
    }
  }, [handleDragOver, handleDragEnter, handleDragLeave, handleDrop])

  useEffect(() => {
    setSortedItems(itemsArray)
  }, [itemsArray])

  // With subscriptions already present the progress card is not on screen, so
  // the round trip would run invisibly. Report it here instead — but only in
  // that case, or the card and these toasts would say the same thing twice.
  const hasItems = sortedItems.length > 0
  useEffect(() => {
    if (!hasItems) return undefined
    return window.electron.ipcRenderer.on(
      'subscription-connect-status',
      (_event, payload: ConnectStatusEvent) => {
        const id = 'subscription-connect'
        if (payload.status === 'waiting') {
          toast.loading(tRef.current('pages.home.connectWaiting'), {
            id,
            description: tRef.current('pages.home.connectWaitingHint')
          })
        } else if (payload.status === 'fetching' || payload.status === 'importing') {
          toast.loading(tRef.current('pages.home.connectFetching'), { id })
        } else if (payload.status === 'done') {
          toast.success(tRef.current('pages.home.connectButton'), { id, description: undefined })
        } else if (payload.status === 'failed') {
          toast.error(tRef.current('pages.home.connectFailed'), {
            id,
            description: payload.message
          })
        }
      }
    )
  }, [hasItems])

  const handleAddProfile = (): void => {
    const newProfile: ProfileItem = {
      id: '',
      name: '',
      type: 'remote',
      url: '',
      useProxy: false,
      autoUpdate: true
    }
    setEditingItem(newProfile)
    setShowEditModal(true)
  }

  return (
    <BasePage
      ref={pageRef}
      title={t('pages.profiles.title')}
      header={
        <>
          {/* Two ways in, not one: the cabinet round trip is the main path and
              has to stay reachable once a subscription already exists — a
              person with a stale link should not have to delete it first. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="new-profile app-nodrag" variant="ghost" size="icon-sm">
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openLogin(true)}>
                {t('pages.home.connectButton')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleAddProfile}>
                {t('pages.home.connectManual')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="icon-sm"
            title={t('pages.profiles.updateAll')}
            className="app-nodrag"
            variant="ghost"
            aria-label={t('pages.profiles.updateAll')}
            onClick={async () => {
              setUpdating(true)
              for (const item of itemsArray) {
                if (item.id === current) continue
                if (item.type !== 'remote') continue
                await addProfileItem(item)
              }
              const currentItem = itemsArray.find((item) => item.id === current)
              if (currentItem && currentItem.type === 'remote') {
                await addProfileItem(currentItem)
              }
              setUpdating(false)
            }}
          >
            <RefreshCcw className={`text-lg ${updating ? 'animate-spin' : ''}`} />
          </Button>
        </>
      }
    >
      {showEditModal && editingItem && (
        <EditInfoModal
          item={editingItem}
          isCurrent={editingItem.id === current}
          updateProfileItem={async (item: ProfileItem) => {
            await addProfileItem(item)
          }}
          onClose={() => {
            setShowEditModal(false)
            setEditingItem(null)
          }}
        />
      )}

      {/* File drop overlay */}
      {fileOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5 px-12 py-8">
            <FileDown className="size-10 text-primary" />
            <span className="text-sm font-medium text-primary">
              {t('pages.profiles.dropFileHint')}
            </span>
          </div>
        </div>
      )}

      {sortedItems.length === 0 ? (
        // Same card as the home screen: deleting the last subscription must
        // offer the same way back in, not the old manual-only prompt.
        <div className="h-full w-full flex justify-center items-center">
          <SubscriptionEmptyState onManual={handleAddProfile} />
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 mx-2 mb-2">
            <SortableContext
              items={sortedItems.map((item) => {
                return item.id
              })}
            >
              {sortedItems.map((item) => (
                <ProfileItem
                  key={item.id}
                  isCurrent={item.id === current}
                  addProfileItem={addProfileItem}
                  removeProfileItem={removeProfileItem}
                  updateProfileItem={updateProfileItem}
                  info={item}
                  switching={switching}
                  onClick={async () => {
                    setSwitching(true)
                    await changeCurrentProfile(item.id)
                    await new Promise((resolve) => setTimeout(resolve, 500))
                    setSwitching(false)
                  }}
                />
              ))}
            </SortableContext>
          </div>
        </DndContext>
      )}
    </BasePage>
  )
}

export default Profiles
