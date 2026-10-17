import { useI18n } from '../lib/i18n'
import { REPO_URL, INSTALL_COMMAND } from '../content/copy'
import markUrl from '../assets/tessera-mark.webp'
import { GitHubIcon } from './icons'
import { InstallCommand } from './InstallCommand'
import { LangToggle } from './LangToggle'

/**
 * One screen, centred, like a title card — the same plate as the Orbit site.
 *
 * The rule is icons first: a mark instead of a word wherever a mark is
 * unambiguous (the repo, the workspace on your machine), and only the words that
 * carry meaning — the promise, the one-line definition, the command.
 */
export function Stage() {
  const { c } = useI18n()

  return (
    <section className="stage" id="top">
      <header className="stage__top">
        <a className="stage__brand" href="#top" aria-label="Tessera">
          <img src={markUrl} alt="" width={30} height={30} />
          <span>Tessera</span>
        </a>

        <div className="stage__top-end is-actions">
          <a
            className="stage__icon-link"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label={c.nav.repo}
            title={c.nav.repo}
          >
            <GitHubIcon />
          </a>
          <LangToggle />
        </div>
      </header>

      <div className="stage__copy">
        <h1 className="stage__title">
          {c.hero.title.map((line, index) => (
            <span className={index === 1 ? 'gradient-text' : undefined} key={line}>
              {line}
            </span>
          ))}
        </h1>

        <p className="stage__lede">{c.hero.lede}</p>

        <div className="stage__cta">
          <InstallCommand command={INSTALL_COMMAND} />
          <a className="btn btn--ghost" href={REPO_URL} target="_blank" rel="noreferrer">
            <GitHubIcon />
            <span>{c.hero.star}</span>
          </a>
        </div>
      </div>

      <footer className="stage__foot">
        <span className="stage__foot-label">{c.databases.label}</span>
        <ul className="stage__platforms">
          {c.databases.items.map((database) => (
            <li key={database.label}>
              <span className="stage__dot" style={{ background: database.dot }} aria-hidden="true" />
              <span>{database.label}</span>
            </li>
          ))}
        </ul>
      </footer>
    </section>
  )
}
