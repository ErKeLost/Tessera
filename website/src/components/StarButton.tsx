import { useEffect, useState } from 'react'

import { REPO_URL } from '../content/copy'
import { useI18n } from '../lib/i18n'
import { GitHubIcon } from './icons'

const API = 'https://api.github.com/repos/ErKeLost/Tessera'
const CACHE_KEY = 'tessera.stars.v1'
const CACHE_TTL = 15 * 60 * 1000

type Cached = { count: number; at: number }

/** Compact star counts: 1_284 → 1.3k, 23_400 → 23k. */
function compact(count: number): string {
  if (count < 1000) return String(count)
  const thousands = count / 1000
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`
}

function readCache(): number | undefined {
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const cached = JSON.parse(raw) as Cached
    if (Date.now() - cached.at > CACHE_TTL) return undefined
    return cached.count
  } catch {
    return undefined
  }
}

/**
 * The GitHub button. The count is decoration on top of a working link: if the
 * API is rate-limited or offline, the button simply loses its number.
 */
export function StarButton() {
  const { c } = useI18n()
  const [stars, setStars] = useState<number | undefined>(readCache)

  useEffect(() => {
    if (stars !== undefined) return

    const controller = new AbortController()
    fetch(API, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: { stargazers_count?: number }) => {
        if (typeof data.stargazers_count !== 'number') return
        setStars(data.stargazers_count)
        try {
          window.sessionStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ count: data.stargazers_count, at: Date.now() } satisfies Cached),
          )
        } catch {
          // Cache is optional.
        }
      })
      .catch(() => {
        // A missing count is fine; the link still goes where it should.
      })

    return () => controller.abort()
  }, [stars])

  return (
    <a className="btn btn--glass star-btn" href={REPO_URL} target="_blank" rel="noreferrer">
      <GitHubIcon />
      <span>{c.hero.star}</span>
      {stars === undefined ? null : <span className="star-btn__count">{compact(stars)}</span>}
    </a>
  )
}
