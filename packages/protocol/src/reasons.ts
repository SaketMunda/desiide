import { z } from 'zod';

export const PolicyOutcome = z.enum(['auto', 'confirm', 'block']);
export type PolicyOutcome = z.infer<typeof PolicyOutcome>;

/**
 * Reason labels are extensible strings (`label` or `label:detail`, e.g. `deny_list:rm_rf`).
 * Clients must render unknown labels generically rather than reject them.
 */
export const ReasonLabel = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9_]*(:[A-Za-z0-9_@./:-]+)?$/, 'expected label or label:detail');
export type ReasonLabel = z.infer<typeof ReasonLabel>;

/** Labels known at this protocol version; the UI maps these to text (JEV-2). */
export const KNOWN_REASON_LABELS = [
  'deny_list',
  'read_only_allow',
  'sensitive_file',
  'multi_file_edit',
  'destructive_action',
  'high_risk_area',
  'irreversible',
  'not_safe_now',
  'jev_confident',
  'jev_uncertain',
  'jev_unavailable',
  'policy_override',
  'approved_for_task',
  'user_rejected',
] as const;
