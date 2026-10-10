import type { ViewId } from '../../shared/messages.ts';

export interface WebviewHtmlOptions {
  view: ViewId;
  nonce: string;
  /** `webview.cspSource`: the only origin allowed for styles, fonts and images. */
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  codiconUri: string;
  title: string;
}

export function buildCsp(nonce: string, cspSource: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource}`,
    // 'strict-dynamic': chunks the nonce'd bundle imports (highlight.js grammars) may load; no
    // other script can.
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
  ].join('; ');
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildWebviewHtml(o: WebviewHtmlOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(buildCsp(o.nonce, o.cspSource))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(o.title)}</title>
<link rel="stylesheet" href="${escapeAttr(o.codiconUri)}">
<link rel="stylesheet" href="${escapeAttr(o.styleUri)}">
</head>
<body>
<div id="root" data-view="${escapeAttr(o.view)}"></div>
<script type="module" nonce="${escapeAttr(o.nonce)}" src="${escapeAttr(o.scriptUri)}"></script>
</body>
</html>`;
}
