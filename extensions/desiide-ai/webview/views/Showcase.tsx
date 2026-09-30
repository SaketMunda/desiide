import { useState } from 'preact/hooks';
import { isBoolean, usePersistentState } from '../bridge.ts';
import {
  Badge,
  Button,
  Card,
  Chip,
  CodeBlock,
  Collapsible,
  EmptyState,
  IconButton,
  ProbabilityBar,
  ScoreDots,
  Spinner,
} from '../ui/index.ts';

/** Dev-only gallery of every UI kit component (`desiide.dev.showcase`). */
export function Showcase() {
  const [whyOpen, setWhyOpen] = usePersistentState('showcase.whyOpen', false, isBoolean);
  const [clicks, setClicks] = useState(0);

  return (
    <div class="desiide-view">
      <h1 class="desiide-section-title">UI kit showcase</h1>

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
