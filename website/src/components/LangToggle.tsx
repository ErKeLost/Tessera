import { useI18n } from '../lib/i18n'
import type { Lang } from '../content/copy'

const LANGS: { value: Lang; label: string }[] = [
  { value: 'en', label: 'EN' },
  { value: 'zh', label: '中文' },
]

export function LangToggle() {
  const { lang, setLang, c } = useI18n()

  return (
    <div className="lang" role="group" aria-label={c.nav.langLabel}>
      {LANGS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={lang === option.value}
          onClick={() => setLang(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
