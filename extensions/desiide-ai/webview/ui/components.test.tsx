import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { Button, IconButton } from './Button.tsx';
import { Chip } from './Chip.tsx';
import { Collapsible } from './Collapsible.tsx';
import { ProbabilityBar } from './ProbabilityBar.tsx';
import { ScoreDots } from './ScoreDots.tsx';
import { Spinner } from './Spinner.tsx';
import { BlockedNote, DecisionChip, NeedsYou, RunMark, ThinkingLabel } from './states.tsx';

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

describe('AI state components', () => {
  it('ThinkingLabel shimmers only while live', () => {
    expect(render(<ThinkingLabel live elapsed="2 s" />)).toContain('is-live');
    const done = render(<ThinkingLabel live={false} elapsed="3 s" />);
    expect(done).not.toContain('is-live');
    expect(done).toContain('Thought for 3 s');
  });

  it('DecisionChip is a labelled meter and pulses only when asked', () => {
    const summary = { label: 'Jev · route', probability: 0.824, probabilityLabel: 'local' };
    const html = render(<DecisionChip summary={summary} />);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="82"');
    expect(html).toContain('aria-valuetext="local 82%"');
    expect(html).not.toContain('is-landing');
    expect(render(<DecisionChip summary={summary} pulse />)).toContain('is-landing');
    expect(render(<DecisionChip summary={summary} onClick={() => undefined} />)).toContain(
      'type="button"',
    );
  });

  it('RunMark spins while running and names its status for screen readers', () => {
    const running = render(<RunMark status="running" label="running" />);
    expect(running).toContain('desiide-spin');
    expect(running).toContain('running</span>');
    const done = render(<RunMark status="done" label="done" />);
    expect(done).toContain('codicon-check');
    expect(done).not.toContain('desiide-spin');
    // Mounted as done: no landing pop (it only plays when it finishes on screen).
    expect(done).not.toContain('is-landing');
    expect(render(<RunMark status="failed" label="failed" />)).toContain('codicon-close');
  });

  it('NeedsYou announces politely until answered; the nudge is on the button', () => {
    expect(render(<NeedsYou title="Run tests?" />)).toContain('aria-live="polite"');
    expect(render(<NeedsYou title="Run tests?" answered />)).not.toContain('aria-live');
    expect(render(<Button nudge>Run once</Button>)).toContain('desiide-button--nudge');
    expect(render(<Button>Run once</Button>)).not.toContain('nudge');
  });

  it('BlockedNote marks the blocked state', () => {
    expect(render(<BlockedNote title="Stopped" />)).toContain('data-state="blocked"');
  });
});
