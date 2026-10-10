import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';

type Loader = () => Promise<{ default: LanguageFn }>;

/**
 * Languages load on first use, each its own chunk, so the panel's bundle carries only the
 * highlight.js core. Keys are fence names; aliases point at the same loader.
 */
const LOADERS: Record<string, Loader> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  python: () => import('highlight.js/lib/languages/python'),
  bash: () => import('highlight.js/lib/languages/bash'),
  shell: () => import('highlight.js/lib/languages/shell'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  swift: () => import('highlight.js/lib/languages/swift'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  sql: () => import('highlight.js/lib/languages/sql'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  ini: () => import('highlight.js/lib/languages/ini'),
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsonc: 'json',
  py: 'python',
  sh: 'bash',
  zsh: 'bash',
  console: 'shell',
  rs: 'rust',
  kt: 'kotlin',
  h: 'c',
  hpp: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  yml: 'yaml',
  md: 'markdown',
  patch: 'diff',
  docker: 'dockerfile',
  toml: 'ini',
};

const loading = new Map<string, Promise<boolean>>();

/** The canonical name for a fence language, or undefined when we have no grammar for it. */
export function resolveLanguage(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  const id = ALIASES[lower] ?? lower;
  return id in LOADERS ? id : undefined;
}

/** Loads the grammar once. Resolves false when unknown or when loading failed. */
export function loadLanguage(id: string): Promise<boolean> {
  if (hljs.getLanguage(id)) return Promise.resolve(true);
  const loader = LOADERS[id];
  if (!loader) return Promise.resolve(false);
  let pending = loading.get(id);
  if (!pending) {
    pending = loader().then(
      (mod) => {
        hljs.registerLanguage(id, mod.default);
        return true;
      },
      () => {
        loading.delete(id);
        return false;
      },
    );
    loading.set(id, pending);
  }
  return pending;
}

/** Highlighted HTML (hljs escapes the code), or undefined when the grammar isn't loaded. */
export function highlightSync(code: string, id: string): string | undefined {
  if (!hljs.getLanguage(id)) return undefined;
  try {
    return hljs.highlight(code, { language: id, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}
