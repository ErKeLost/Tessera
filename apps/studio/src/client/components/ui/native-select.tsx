import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default"
}) {
  return (
    <div
      data-slot="native-select-wrapper"
      data-size={size}
      className={cn(
        "group/native-select relative w-fit has-[select:disabled]:opacity-50",
        className
      )}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="h-9 w-full appearance-none rounded-(--radius-control) border border-input bg-card ps-3 pe-9 text-sm shadow-(--shadow-whisper) transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[size=sm]:h-8 dark:aria-invalid:ring-destructive/40"
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        data-slot="native-select-icon"
        className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 select-none opacity-50"
      />
    </div>
  )
}

export { NativeSelect }
