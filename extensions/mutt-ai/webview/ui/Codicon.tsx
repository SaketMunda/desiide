export interface CodiconProps {
  name: string;
  spin?: boolean;
}

/** Decorative icon from the locally bundled codicon font. Label the parent control instead. */
export function Codicon({ name, spin = false }: CodiconProps) {
  const cls = `codicon codicon-${name}${spin ? ' mutt-spin' : ''}`;
  return <span class={cls} aria-hidden="true" />;
}
