import { describe, expect, it } from 'vitest';
import { buildCsp, buildWebviewHtml } from './html.ts';

const opts = {
  view: 'panel' as const,
  nonce: 'abc123==',
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/main.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/main.css',
  codiconUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/codicons/codicon.css',
  title: 'Mutt',
};

describe('buildCsp', () => {
  const csp = buildCsp(opts.nonce, opts.cspSource);

  it('denies everything by default', () => {
    expect(csp.startsWith("default-src 'none'")).toBe(true);
  });

  it('allows scripts only by nonce, never inline or eval', () => {
    expect(csp).toContain("script-src 'nonce-abc123=='");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('allows no network origins other than the webview resource origin', () => {
    const origins = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(origins)).toEqual(new Set([opts.cspSource]));
    expect(csp).not.toMatch(/connect-src|\*/);
  });
});

describe('buildWebviewHtml', () => {
  const html = buildWebviewHtml(opts);

  it('puts the CSP meta first in <head> and nonces the script', () => {
    expect(html).toMatch(
      /<head>\s*<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy"/,
    );
    expect(html).toContain(`<script type="module" nonce="${opts.nonce}" src="${opts.scriptUri}">`);
  });

  it('marks the view on #root', () => {
    expect(html).toContain('<div id="root" data-view="panel"></div>');
  });

  it('only references local resources', () => {
    const urls = html.match(/(?:src|href)="([^"]+)"/g) ?? [];
    expect(urls).toHaveLength(3);
    for (const u of urls) expect(u).toContain(opts.cspSource);
  });

  it('escapes attribute values', () => {
    const evil = buildWebviewHtml({ ...opts, title: '"><script>alert(1)</script>' });
    expect(evil).not.toContain('<script>alert(1)</script>');
  });
});
