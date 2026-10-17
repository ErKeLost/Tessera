import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '../lib/i18n'
import { CheckIcon, CopyIcon } from './icons'

/**
 * The primary button.
 *
 * Where Orbit puts a platform download, Tessera puts the command that starts the
 * Studio — same pill, same pastel gradient, same ink. The label is the command
 * itself, in mono, and pressing it copies the string exactly.
 */
export function InstallCommand({ command }: { command: string }) {
  const { c } = useI18n()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      // The Clipboard API needs a secure context; a selected textarea still works
      // on plain http during previews.
      const field = document.createElement('textarea')
      field.value = command
      field.setAttribute('readonly', '')
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.append(field)
      field.select()
      try {
        document.execCommand('copy')
      } finally {
        field.remove()
      }
    }

    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1800)
  }, [command])

  return (
    <button
      type="button"
      className="btn btn--primary"
      onClick={copy}
      aria-label={`${c.hero.installLabel}: ${command}`}
      title={command}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span className="install__cmd" aria-live="polite">
        {copied ? c.hero.copied : command}
      </span>
    </button>
  )
}
