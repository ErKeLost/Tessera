/**
 * Every string on the page, in both languages.
 *
 * One screen means one argument: the English object is the shape and `zh` is
 * typed against it, so a sentence added in one language and forgotten in the
 * other is a compile error rather than a page that silently falls back.
 */

const en = {
  nav: {
    repo: 'GitHub',
    langLabel: 'Language',
  },
  hero: {
    title: ['Ask your data.', 'See the evidence.'],
    lede: 'A local-first database agent for your machine.',
    star: 'GitHub',
    copy: 'Copy',
    copied: 'Copied',
    installLabel: 'Copy the install command',
  },
  databases: {
    label: 'Works with',
    items: [
      { label: 'PostgreSQL', dot: '#6f92d8' },
      { label: 'MySQL', dot: '#dda43f' },
      { label: 'SQLite', dot: '#8aa4c4' },
      { label: 'Turso', dot: '#8f80ff' },
      { label: 'MongoDB', dot: '#57a37a' },
    ],
  },
  skip: 'Skip to content',
}

type Copy = typeof en

const zh: Copy = {
  nav: {
    repo: 'GitHub',
    langLabel: '语言',
  },
  hero: {
    title: ['问你的数据。', '答案有据可查。'],
    lede: '跑在你机器上的本地优先数据库 agent。',
    star: 'GitHub',
    copy: '复制',
    copied: '已复制',
    installLabel: '复制安装命令',
  },
  databases: {
    label: '支持数据库',
    items: [
      { label: 'PostgreSQL', dot: '#6f92d8' },
      { label: 'MySQL', dot: '#dda43f' },
      { label: 'SQLite', dot: '#8aa4c4' },
      { label: 'Turso', dot: '#8f80ff' },
      { label: 'MongoDB', dot: '#57a37a' },
    ],
  },
  skip: '跳到正文',
}

export type Lang = 'en' | 'zh'
export type { Copy }
export const copy: Record<Lang, Copy> = { en, zh }

/** The one command the page exists to hand over. */
export const INSTALL_COMMAND = 'npx @open-tessera/studio@latest'

export const REPO_URL = 'https://github.com/ErKeLost/Tessera'
