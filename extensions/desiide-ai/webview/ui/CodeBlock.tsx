import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { IconButton } from './Button.tsx';

export interface CodeBlockProps {
  code: string;
  language?: string | undefined;
  /** Highlighted HTML for `code` (highlight.js output, already escaped). Plain text when absent. */
  html?: string | undefined;
  /** Extra buttons next to Copy (e.g. the transcript's "Insert at cursor"). */
  actions?: ComponentChildren;
}

/** Code block with copy, and optional highlighting and actions. */
export function CodeBlock({ code, language, html, actions }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div class="desiide-code">
      <div class="desiide-code__bar">
        <span class="desiide-code__lang">{language ?? 'text'}</span>
        <span class="desiide-code__actions">
          {actions}
          <IconButton
            icon={copied ? 'check' : 'copy'}
            label={copied ? 'Copied' : 'Copy code'}
            onClick={() => void copy()}
          />
        </span>
      </div>
      <pre class="desiide-code__pre">
        {html === undefined ? (
          <code>{code}</code>
        ) : (
          <code class="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}
