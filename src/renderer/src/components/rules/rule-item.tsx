import React from 'react'
import { Badge } from '@renderer/components/ui/badge'
import ProxyName from '@renderer/components/base/proxy-name'

// Строка правила. Карточки на каждой строке больше нет — см. log-item.tsx.
const RuleItem: React.FC<ControllerRulesDetail & { index: number }> = (props) => {
  const { type, payload, proxy } = props
  return (
    <div className="border-b-[length:var(--hairline)] border-stroke bg-card px-3 py-2">
      {payload && (
        <div title={payload} className="truncate text-sm">
          {payload}
        </div>
      )}
      <div className="mt-1 flex gap-1.5">
        <Badge variant="outline" className="rounded-sm">
          {type}
        </Badge>
        <Badge variant="outline" className="overflow-hidden rounded-sm whitespace-nowrap">
          {/* Имя узла с нашим флагом — см. connection-item.tsx. */}
          <ProxyName name={proxy} size={12} />
        </Badge>
      </div>
    </div>
  )
}

export default RuleItem
