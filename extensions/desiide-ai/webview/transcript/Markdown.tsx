import { memo } from 'preact/compat';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { post } from '../bridge.ts';
import { CodeBlock, IconButton } from '../ui/index.ts';
import { highlightSync, loadLanguage, resolveLanguage } from './highlight.ts';
import { renderBlocks } from './mdBlocks.ts';

/** Bigger blocks stay plain: highlighting them would cost a long task for little benefit. */
const MAX_HIGHLIGHT_CHARS = 20_000;

/**
 * Assistant markdown. Re-parsed when the text grows (once per frame at most, see the store);
 * unchanged blocks keep their props, so `memo` skips them and only the tail re-renders.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => renderBlocks(text), [text]);
  return (
    <div class="desiide-md">
      {blocks.map((b, i) =>
        b.type === 'html' ? (
          <HtmlBlock key={i} html={b.html} />
        ) : (
          <TranscriptCode key={i} code={b.code} language={b.language} closed={b.closed} />
        ),
      )}
    </div>
  );
}

const HtmlBlock = memo(function HtmlBlock({ html }: { html: string }) {
  // markdown-it output with raw HTML disabled and links restricted to http(s)/mailto.
  return <div class="desiide-md__html" dangerouslySetInnerHTML={{ __html: html }} />;
});

interface TranscriptCodeProps {
  code: string;
  language: string | undefined;
  /** False while the fence is still streaming: no highlighting until it closes. */
  closed: boolean;
}

export const TranscriptCode = memo(function TranscriptCode({
  code,
  language,
  closed,
}: TranscriptCodeProps) {
  const id = resolveLanguage(language);
  const canHighlight = closed && id !== undefined && code.length <= MAX_HIGHLIGHT_CHARS;
  const [html, setHtml] = useState<string | undefined>(() =>
    canHighlight ? highlightSync(code, id) : undefined,
  );
  useEffect(() => {
    if (!canHighlight) {
      setHtml(undefined);
      return undefined;
    }
    let live = true;
    void loadLanguage(id).then((ok) => {
      if (live) setHtml(ok ? highlightSync(code, id) : undefined);
    });
    return () => {
      live = false;
    };
  }, [code, id, canHighlight]);

  return (
    <CodeBlock
      code={code}
      language={language}
      html={html}
      actions={
        <IconButton
          icon="insert"
          label="Insert at cursor"
          onClick={() => post({ type: 'code.insert', code })}
          disabled={code.length === 0}
        />
      }
    />
  );
});
