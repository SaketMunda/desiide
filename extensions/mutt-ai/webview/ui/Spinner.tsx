import { Codicon } from './Codicon.tsx';

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = 'Loading' }: SpinnerProps) {
  return (
    <span class="mutt-spinner" role="status">
      <Codicon name="loading" spin />
      <span class="mutt-visually-hidden">{label}</span>
    </span>
  );
}
