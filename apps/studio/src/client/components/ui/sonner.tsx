"use client"

import { CircleCheck, Info, Loader2, OctagonX, TriangleAlert } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { useStudioTheme } from "@/studio-theme"

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useStudioTheme()

  return (
    <Sonner
      theme={resolvedTheme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <OctagonX className="size-4" />,
        loading: <Loader2 className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-control)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "rounded-(--radius-card)",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
