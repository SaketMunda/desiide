import { Codicon } from './Codicon.tsx';

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = 'Loading' }: SpinnerProps) {
  return (
    <span class="desiide-spinner" role="status">
      <Codicon name="loading" spin />
      <span class="desiide-visually-hidden">{label}</span>
    </span>
  );
}
