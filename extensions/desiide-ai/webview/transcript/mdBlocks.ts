import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

/**
 * Raw HTML in model output is shown as text (`html: false`): the transcript never renders markup
 * a model wrote. Links are allowed only for http(s) and mailto; VS Code opens them outside.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
const SAFE_LINK = /^(https?:|mailto:)/i;
md.validateLink = (url) => SAFE_LINK.test(url.trim());
const defaultLinkOpen =
  md.renderer.rules['link_open'] ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules['link_open'] = (tokens, idx, options, env, self) => {
  tokens[idx]?.attrSet('title', tokens[idx].attrGet('href') ?? '');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export type MarkdownBlock =
  | { type: 'html'; html: string }
  | { type: 'code'; code: string; language: string | undefined; closed: boolean };

/**
 * Splits a (possibly still streaming) markdown message into top-level blocks: code fences become
 * `code` blocks (rendered as components with copy / insert), runs of everything else become
 * sanitized HTML. Consecutive prose stays in one run, so list numbering and loose lists survive.
 */
export function renderBlocks(text: string): MarkdownBlock[] {
  const tokens = md.parse(text, {});
  const blocks: MarkdownBlock[] = [];
  let run: Token[] = [];
  const flush = () => {
    if (run.length === 0) return;
    blocks.push({ type: 'html', html: md.renderer.render(run, md.options, {}) });
    run = [];
  };
  for (const token of tokens) {
    if (token.level === 0 && (token.type === 'fence' || token.type === 'code_block')) {
      flush();
      const language = token.info.trim().split(/\s+/)[0] || undefined;
      blocks.push({
        type: 'code',
        code: token.content.replace(/\n$/, ''),
        language,
        closed: token.type === 'code_block' || isClosedFence(text, token),
      });
    } else {
      run.push(token);
    }
  }
  flush();
  return blocks;
}

/** An unclosed fence (still streaming) runs to the end of the text. */
function isClosedFence(text: string, token: Token): boolean {
  const end = token.map?.[1];
  if (end === undefined) return true;
  const lines = text.split('\n');
  const last = lines[end - 1]?.trim() ?? '';
  return end - 1 > (token.map?.[0] ?? 0) && last.startsWith(token.markup);
}
