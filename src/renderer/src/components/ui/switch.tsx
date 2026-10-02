import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@renderer/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // ⚠️ Включённый переключатель СИНИЙ, а не зелёный. Решение владельца
        // 02.10.2026: зелёное в приложении значит «ВПН включён», и больше
        // ничего. Раньше зелёный градиент «питания» был потрачен на 67
        // переключателей и 35 вкладок, и единственное состояние, ради
        // которого человек открывает программу, перестало читаться.
        "peer group/switch inline-flex shrink-0 items-center rounded-full transition-all outline-none disabled:cursor-not-allowed disabled:opacity-50",
        // Выключенный — плитка со своим волоском, а не полупрозрачная карточка:
        // по карточке bg-card она стала бы с ней одного цвета.
        "data-[state=unchecked]:bg-secondary data-[state=unchecked]:shadow-[inset_0_0_0_var(--hairline)_var(--stroke)]",
        "data-[state=checked]:bg-primary",
        "focus-visible:ring-2 focus-visible:ring-primary",
        "data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // Бегунок белый в обоих состояниях, как у системного переключателя:
          // серый в выключенном читался как «недоступно».
          "pointer-events-none block rounded-full ring-0 shadow-sm transition-transform",
          "bg-white",
          "group-data-[size=default]/switch:size-3.5 group-data-[size=sm]/switch:size-2.5",
          "data-[state=checked]:translate-x-[calc(100%+4px)] data-[state=unchecked]:translate-x-0.5"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
