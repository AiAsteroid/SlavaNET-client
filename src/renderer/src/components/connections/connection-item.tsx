import { Button } from '@renderer/components/ui/button'
import ProxyName from '@renderer/components/base/proxy-name'
import { useProcessIcon, useProcessAppName } from '@renderer/store/icons-store'
import { calcTraffic } from '@renderer/utils/calc'
import dayjs from 'dayjs'
import { cn } from '@renderer/lib/utils'
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Trash2, X } from 'lucide-react'

interface Props {
  index: number
  info: ControllerConnectionDetail
  displayIcon: boolean
  displayAppName: boolean
  /**
   * Whether the owning process should be identified on the row itself.
   * Inside a process drill-down every row belongs to the same app, so the icon
   * and the "process →" prefix are redundant — the app is named in the header.
   */
  showProcess?: boolean
  setSelected: React.Dispatch<React.SetStateAction<ControllerConnectionDetail | undefined>>
  setIsDetailModalOpen: React.Dispatch<React.SetStateAction<boolean>>
  close: (id: string) => void
}

const ConnectionItemComponent: React.FC<Props> = ({
  info,
  displayIcon,
  displayAppName,
  showProcess = true,
  close,
  setSelected,
  setIsDetailModalOpen
}) => {
  const path = info.metadata.processPath || ''
  const showIcon = displayIcon && showProcess
  const iconUrl = useProcessIcon(path, showIcon)
  const displayName = useProcessAppName(path, displayAppName && showProcess)
  const fallbackProcessName = useMemo(
    () => info.metadata.process || info.metadata.sourceIP,
    [info.metadata.process, info.metadata.sourceIP]
  )
  const processName = displayName || fallbackProcessName

  const destination = useMemo(
    () =>
      info.metadata.host ||
      info.metadata.sniffHost ||
      info.metadata.destinationIP ||
      info.metadata.remoteDestination,
    [
      info.metadata.host,
      info.metadata.sniffHost,
      info.metadata.destinationIP,
      info.metadata.remoteDestination
    ]
  )

  const primaryLabel = useMemo(
    () => (showProcess ? `${processName} → ${destination}` : destination),
    [showProcess, processName, destination]
  )

  const [timeAgo, setTimeAgo] = useState(() => dayjs(info.start).fromNow())

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeAgo(dayjs(info.start).fromNow())
    }, 60000)

    return () => clearInterval(timer)
  }, [info.start])

  const uploadTraffic = useMemo(() => calcTraffic(info.upload), [info.upload])

  const downloadTraffic = useMemo(() => calcTraffic(info.download), [info.download])

  const uploadSpeed = useMemo(
    () => (info.uploadSpeed ? calcTraffic(info.uploadSpeed) : null),
    [info.uploadSpeed]
  )

  const downloadSpeed = useMemo(
    () => (info.downloadSpeed ? calcTraffic(info.downloadSpeed) : null),
    [info.downloadSpeed]
  )

  const hasSpeed = useMemo(
    () => Boolean(info.uploadSpeed || info.downloadSpeed),
    [info.uploadSpeed, info.downloadSpeed]
  )

  const handleCardPress = useCallback(() => {
    setSelected(info)
    setIsDetailModalOpen(true)
  }, [info, setSelected, setIsDetailModalOpen])

  const handleClose = useCallback(() => {
    close(info.id)
  }, [close, info.id])

  return (
    <div style={{ height: 72 }}>
      <div
        className={cn(
          'flex h-full w-full cursor-pointer items-center',
          'border-b-[length:var(--hairline)] border-stroke transition-colors',
          info.isActive
            ? 'bg-[color:color-mix(in_oklab,var(--success)_10%,var(--card))] hover:bg-[color:color-mix(in_oklab,var(--success)_16%,var(--card))]'
            : 'bg-card hover:bg-accent/50'
        )}
        onClick={handleCardPress}
      >
        <div className="w-full flex items-center">
          {showIcon && (
            <div className="pl-3">
              {iconUrl ? (
                <img src={iconUrl} alt="" className="size-12 shrink-0" />
              ) : (
                <div className="size-12 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <span className="text-xs font-semibold text-muted-foreground">
                    {(processName || '').slice(0, 2).toUpperCase()}
                  </span>
                </div>
              )}
            </div>
          )}
          <div className={`flex-1 flex flex-col truncate ${showIcon ? 'pl-3' : 'pl-4'} pr-1`}>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <span className="text-sm font-medium truncate" title={primaryLabel}>
                  {primaryLabel}
                </span>
              </div>
              <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                {timeAgo}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className={`size-7 shrink-0 ${info.isActive ? 'text-warning hover:bg-warning/10' : 'text-destructive hover:bg-destructive/10'}`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleClose()
                }}
              >
                {info.isActive ? <X /> : <Trash2 />}
              </Button>
            </div>
            <div className="flex items-center gap-1.5 pb-1">
              <span className="text-xs text-muted-foreground">
                {info.metadata.type}({info.metadata.network.toUpperCase()})
              </span>
              <span className="text-xs text-muted-foreground/40">|</span>
              {/* Имя узла — то же, что в списке серверов, и флаг у него такой
                  же: картинка, а не эмодзи. На Windows эмодзи-флаг система
                  рисует двумя буквами кода, и строка выглядит сломанной. */}
              <ProxyName
                name={info.chains[0]}
                size={12}
                className="text-xs text-muted-foreground"
              />
              <span className="text-xs text-muted-foreground/40">|</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                ↑ {uploadTraffic} ↓ {downloadTraffic}
              </span>
              {hasSpeed && (
                <>
                  <span className="text-xs text-muted-foreground/40">|</span>
                  <span
                    className={`text-xs tabular-nums ${info.isActive ? 'text-gradient-end-power-on' : 'text-muted-foreground'}`}
                  >
                    ↑ {uploadSpeed || '0 B'}/s ↓ {downloadSpeed || '0 B'}/s
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const ConnectionItem = memo(ConnectionItemComponent, (prevProps, nextProps) => {
  return (
    prevProps.info.id === nextProps.info.id &&
    prevProps.info.upload === nextProps.info.upload &&
    prevProps.info.download === nextProps.info.download &&
    prevProps.info.uploadSpeed === nextProps.info.uploadSpeed &&
    prevProps.info.downloadSpeed === nextProps.info.downloadSpeed &&
    prevProps.info.isActive === nextProps.info.isActive &&
    prevProps.displayIcon === nextProps.displayIcon &&
    prevProps.displayAppName === nextProps.displayAppName &&
    prevProps.showProcess === nextProps.showProcess
  )
})

export default ConnectionItem
