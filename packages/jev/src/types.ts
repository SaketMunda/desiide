import type { JevEngineKind, JevPackState, JevResult, KnownPack } from '@desiide/protocol';

export type ChoiceResult = Extract<JevResult, { kind: 'choice' }>;
export type ScoreResult = Extract<JevResult, { kind: 'score' }>;
export type NoulResult = Extract<JevResult, { kind: 'noul' }>;
export type QuestionType = JevResult['kind'];

export interface JevRequest {
  state: JevPackState;
  /** Question id within the state's pack, e.g. `safe_now`. */
  question: string;
}

export interface ChoiceRequest extends JevRequest {
  /**
   * Options to choose between. Defaults to the pack's allowed options for this state
   * (e.g. workflow options whose models are configured). Must be a subset of the question's options.
   */
  options?: readonly string[];
}

/** Why the selector answered with rules instead of the configured Jev engine. */
export type FallbackReason = 'jev_unavailable' | 'jev_timeout' | 'jev_error';

export interface JevAnswer<R extends JevResult = JevResult> {
  /** Which engine actually produced `result` (shown in the Decision panel). */
  engine: JevEngineKind;
  result: R;
  /**
   * Structured labels explaining the answer (`read_only_command`, `sensitive_file`, ...).
   * The rules engine always fills this; Jev may leave it empty.
   */
  rationale: string[];
  latencyMs: number;
  /** Set when the selector fell back to rules for this call. */
  fallbackReason?: FallbackReason;
}

/** Same surface for the rules engine (JEV-1) and the TypeSafe HTTP engine (JEV-3). */
export interface JevEngine {
  readonly kind: JevEngineKind;
  choice(request: ChoiceRequest, signal?: AbortSignal): Promise<JevAnswer<ChoiceResult>>;
  score(request: JevRequest, signal?: AbortSignal): Promise<JevAnswer<ScoreResult>>;
  noul(request: JevRequest, signal?: AbortSignal): Promise<JevAnswer<NoulResult>>;
}

export type JevRequestErrorCode =
  'invalid_state' | 'unknown_pack' | 'unknown_question' | 'wrong_question_type' | 'invalid_options';

/** A caller bug (bad state, question, or options), not an engine failure: never falls back. */
export class JevRequestError extends Error {
  override readonly name = 'JevRequestError';
  readonly code: JevRequestErrorCode;
  readonly pack: KnownPack | string | undefined;

  constructor(code: JevRequestErrorCode, message: string, pack?: KnownPack | string) {
    super(message);
    this.code = code;
    this.pack = pack;
  }
}
