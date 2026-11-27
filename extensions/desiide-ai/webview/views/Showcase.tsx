import { useState } from 'preact/hooks';
import { isBoolean, usePersistentState } from '../bridge.ts';
import {
  Badge,
  BlockedNote,
  Button,
  Card,
  Chip,
  CodeBlock,
  Collapsible,
  DecisionChip,
  EmptyState,
  IconButton,
  NeedsYou,
  ProbabilityBar,
  RunMark,
  ScoreDots,
  Spinner,
  ThinkingLabel,
} from '../ui/index.ts';

/** The five AI states (UI-7) in their shared treatments; the Chromium harness renders this. */
function AiStates() {
  const [answered, setAnswered] = useState(false);
  return (
    <section class="desiide-states" aria-label="AI states">
      <h2 class="desiide-section-title">AI states</h2>
      <div class="desiide-row" data-demo="thinking">
        <ThinkingLabel live elapsed="2.4 s" />
        <ThinkingLabel live={false} elapsed="3.1 s" />
      </div>
      <div class="desiide-row" data-demo="decision">
        <DecisionChip
          pulse
          summary={{
            label: 'Jev · route',
            workflow: 'local-single',
            probability: 0.82,
            probabilityLabel: 'local-single',
          }}
        />
        <DecisionChip
          summary={{
            label: 'rules · risk gate',
            outcome: 'confirm',
            probability: 0.18,
            probabilityLabel: 'safe now',
          }}
        />
      </div>
      <div class="desiide-row" data-demo="running">
        <RunMark status="running" label="running" />
        <span class="desiide-muted">npm test</span>
        <RunMark status="done" label="done" />
        <span class="desiide-muted">read src/auth/session.ts</span>
        <RunMark status="failed" label="failed" />
        <span class="desiide-muted">lint</span>
      </div>
      <NeedsYou
        answered={answered}
        title="Run the test suite?"
        actions={
          <>
            <Button nudge={!answered} icon="check" onClick={() => setAnswered(true)}>
              Run once
            </Button>
            <Button variant="secondary" onClick={() => setAnswered(true)}>
              Not now
            </Button>
          </>
        }
      >
        <code>npm test</code> runs a command on your machine. It can't change files.
      </NeedsYou>
      <BlockedNote title="Stopped by the deny-list">
        <code>curl … | sh</code> pipes the internet into a shell, so Desiide won't run it. Nothing
        was changed.
      </BlockedNote>
    </section>
  );
}

/** Dev-only gallery of every UI kit component (`desiide.dev.showcase`). */
export function Showcase() {
  const [whyOpen, setWhyOpen] = usePersistentState('showcase.whyOpen', false, isBoolean);
  const [clicks, setClicks] = useState(0);

  return (
    <div class="desiide-view">
      <h1 class="desiide-section-title">UI kit showcase</h1>

      <AiStates />

      <div class="desiide-row">
        <Button icon="play" onClick={() => setClicks(clicks + 1)}>
          Run once
        </Button>
        <Button variant="secondary" icon="check-all">
          Allow for task
        </Button>
        <Button variant="ghost">Reject</Button>
        <Button disabled>Disabled</Button>
        <IconButton icon="refresh" label="Replay decision" />
        <IconButton icon="close" label="Dismiss" />
      </div>

      <div class="desiide-row">
        <Badge>neutral</Badge>
        <Badge tone="ai">ai</Badge>
        <Badge tone="jev">jev</Badge>
        <Badge tone="auto">auto</Badge>
        <Badge tone="confirm">confirm</Badge>
        <Badge tone="block">block</Badge>
      </div>

      <div class="desiide-row">
        <Chip
          tone="jev"
          icon="git-merge"
          onClick={() => setClicks(clicks + 1)}
          label="Open decision"
        >
          routed via Jev → cascade
        </Chip>
        <Chip tone="ai" icon="sparkle">
          claude-strong
        </Chip>
        <Chip icon="file">src/billing/invoice.ts</Chip>
        {clicks > 0 && <Chip tone="auto">clicked {clicks}×</Chip>}
      </div>

      <Card
        tone="confirm"
        title={
          <>
            <Badge tone="confirm">confirm</Badge>
            <span>risk_gate@1 · safe_now</span>
          </>
        }
        actions={<IconButton icon="info" label="Why?" />}
      >
        <div style={{ display: 'grid', gap: '8px' }}>
          <code>npm run migrate</code>
          <ProbabilityBar label="safe_now (yes)" value={0.05} tone="block" />
          <ProbabilityBar label="reversible (yes)" value={0.42} tone="confirm" />
          <ProbabilityBar label="high_risk_area (yes)" value={0.91} tone="jev" />
          <div class="desiide-row">
            <span>complexity</span>
            <ScoreDots label="Complexity" score={3} />
            <span>escalation_need</span>
            <ScoreDots label="Escalation need" score={1} />
          </div>
          <div class="desiide-row">
            <Chip tone="block">sensitive_file</Chip>
            <Chip tone="confirm">high_risk_area</Chip>
            <Badge tone="jev">rules</Badge>
          </div>
        </div>
      </Card>

      <Card tone="ai" title="Streaming">
        <div class="desiide-row">
          <Spinner label="Model is responding" />
          <span>Drafting with cheap model…</span>
        </div>
      </Card>

      <Collapsible title="Why? (state sent)" open={whyOpen} onToggle={setWhyOpen}>
        <CodeBlock
          language="json"
          code={JSON.stringify(
            { pack: 'risk_gate@1', actionType: 'run_command', command: 'npm run migrate' },
            null,
            2,
          )}
        />
      </Collapsible>

      <Card>
        <EmptyState
          icon="sparkle"
          title="No tasks yet"
          description="Describe a change and Desiide will route it to the right model."
          action={<Button icon="add">New task</Button>}
        />
      </Card>
    </div>
  );
}
