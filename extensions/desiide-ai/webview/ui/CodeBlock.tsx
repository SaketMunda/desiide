import { useState } from 'preact/hooks';
import { IconButton } from './Button.tsx';

export interface CodeBlockProps {
  code: string;
  language?: string;
}

/** Plain code block with copy. Syntax highlighting arrives with UI-3. */
export function CodeBlock({ code, language }: CodeBlockProps) {
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
        <IconButton
          icon={copied ? 'check' : 'copy'}
          label={copied ? 'Copied' : 'Copy code'}
          onClick={() => void copy()}
        />
      </div>
      <pre class="desiide-code__pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}
