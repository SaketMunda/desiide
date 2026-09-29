import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import { Codicon } from './Codicon.tsx';

export interface CollapsibleProps {
  title: ComponentChildren;
  defaultOpen?: boolean;
  /** Controlled mode (e.g. persisted with `usePersistentState`). */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ComponentChildren;
}

export function Collapsible({
  title,
  defaultOpen = false,
  open,
  onToggle,
  children,
}: CollapsibleProps) {
  const [internal, setInternal] = useState(defaultOpen);
  const isOpen = open ?? internal;
  const id = useId();
  const toggle = () => {
    setInternal(!isOpen);
    onToggle?.(!isOpen);
  };
  return (
    <div class="mutt-collapsible">
      <button
        type="button"
        class="mutt-collapsible__trigger"
        aria-expanded={isOpen}
        aria-controls={id}
        onClick={toggle}
      >
        <Codicon name={isOpen ? 'chevron-down' : 'chevron-right'} />
        <span>{title}</span>
      </button>
      <div id={id} class="mutt-collapsible__content" hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}
