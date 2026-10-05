/**
 * Policy thresholds that turn risk_gate answers into auto / confirm / block. These are the
 * conservative defaults (ADR-006, ADR-019). Users may make them stricter via
 * `desiide.gating.thresholds`, never looser: `resolveThresholds` drops loosening overrides and
 * says why.
 */
export interface Thresholds {
  /** `auto` needs `safe_now.pYes` at least this. Higher is stricter. */
  autoSafeNowMin: number;
  /** `auto` needs `reversible.pYes` at least this. Higher is stricter. */
  autoReversibleMin: number;
  /** `auto` needs `high_risk_area.pYes` below this. Lower is stricter. */
  autoHighRiskMax: number;
  /** `safe_now.pYes` below this blocks. Higher is stricter. */
  blockSafeNowBelow: number;
  /** Edits touching more files than this ask first. Lower is stricter. */
  maxAutoEditFiles: number;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  autoSafeNowMin: 0.9,
  autoReversibleMin: 0.8,
  autoHighRiskMax: 0.2,
  blockSafeNowBelow: 0.3,
  maxAutoEditFiles: 1,
});

type Direction = 'higher' | 'lower';

/** Which way each threshold gets stricter, and its valid range. */
const RULES: Record<keyof Thresholds, { stricter: Direction; min: number; max: number }> = {
  autoSafeNowMin: { stricter: 'higher', min: 0, max: 1 },
  autoReversibleMin: { stricter: 'higher', min: 0, max: 1 },
  autoHighRiskMax: { stricter: 'lower', min: 0, max: 1 },
  blockSafeNowBelow: { stricter: 'higher', min: 0, max: 1 },
  maxAutoEditFiles: { stricter: 'lower', min: 0, max: 1000 },
};

export interface ResolvedThresholds {
  thresholds: Thresholds;
  /** One human-readable line per rejected override, for the settings UI and the log. */
  warnings: string[];
}

function isKey(key: string): key is keyof Thresholds {
  return Object.hasOwn(RULES, key);
}

/**
 * Applies user overrides on top of the defaults. An override that loosens a threshold, is out of
 * range, or is unknown is ignored with a warning, so a typo or a hand-edited settings.json can
 * never make gating weaker.
 */
export function resolveThresholds(
  overrides: Readonly<Record<string, number>> = {},
): ResolvedThresholds {
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!isKey(key)) {
      warnings.push(`Ignored desiide.gating.thresholds.${key}: unknown threshold.`);
      continue;
    }
    const rule = RULES[key];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < rule.min ||
      value > rule.max
    ) {
      warnings.push(
        `Ignored desiide.gating.thresholds.${key} = ${String(value)}: must be between ${rule.min} and ${rule.max}.`,
      );
      continue;
    }
    const base = DEFAULT_THRESHOLDS[key];
    const looser = rule.stricter === 'higher' ? value < base : value > base;
    if (looser) {
      warnings.push(
        `Ignored desiide.gating.thresholds.${key} = ${value}: it would loosen gating ` +
          `(default ${base}; only ${rule.stricter === 'higher' ? 'higher' : 'lower'} values are allowed).`,
      );
      continue;
    }
    thresholds[key] = value;
  }
  return { thresholds, warnings };
}
