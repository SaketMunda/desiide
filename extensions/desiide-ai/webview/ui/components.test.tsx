import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { Button, IconButton } from './Button.tsx';
import { Chip } from './Chip.tsx';
import { Collapsible } from './Collapsible.tsx';
import { ProbabilityBar } from './ProbabilityBar.tsx';
import { ScoreDots } from './ScoreDots.tsx';
import { Spinner } from './Spinner.tsx';

describe('UI kit accessibility', () => {
  it('IconButton exposes its label as the accessible name', () => {
    const html = render(<IconButton icon="refresh" label="Replay decision" />);
    expect(html).toContain('aria-label="Replay decision"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('Button defaults to type=button so it never submits forms', () => {
    expect(render(<Button>Go</Button>)).toContain('type="button"');
  });

  it('ProbabilityBar is a labelled meter with a clamped value', () => {
    const html = render(<ProbabilityBar label="safe_now" value={1.4} />);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-label="safe_now"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('width:100%');
  });

  it('ScoreDots announces the score and fills that many dots', () => {
    const html = render(<ScoreDots label="Complexity" score={3} />);
    expect(html).toContain('aria-label="Complexity: 3 of 4"');
    expect(html.match(/desiide-score__dot--on/g)).toHaveLength(3);
  });

  it('Collapsible reflects its state in aria-expanded', () => {
    expect(render(<Collapsible title="Why?">x</Collapsible>)).toContain('aria-expanded="false"');
    expect(
      render(
        <Collapsible title="Why?" open>
          x
        </Collapsible>,
      ),
    ).toContain('aria-expanded="true"');
  });

  it('interactive Chip renders a button; static Chip does not', () => {
    expect(render(<Chip onClick={() => undefined}>x</Chip>)).toMatch(/^<button/);
    expect(render(<Chip>x</Chip>)).toMatch(/^<span/);
  });

  it('Spinner has a status role and a text label', () => {
    const html = render(<Spinner label="Thinking" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Thinking');
  });
});
