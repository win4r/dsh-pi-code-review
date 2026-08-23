/**
 * Canonical shapes shared across the plugin.
 *
 * These are written as `type` aliases rather than interfaces on purpose: the
 * harness types `stats` as a lossless-JSON node, and only type aliases pick up
 * the implicit index signature that makes them assignable to `JsonValue`.
 */

/** Ascending order; index position is the ranking used by `severityAtLeast`. */
export const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'] as const
/** Descending order, for schema enums and report rendering. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export const CATEGORIES = [
  'correctness',
  'security',
  'performance',
  'maintainability',
  'testing',
  'style',
  'docs',
] as const
export const VERDICTS = ['approve', 'comment', 'request-changes'] as const
export const CONFIDENCES = ['high', 'medium', 'low'] as const
export const SCOPES = [
  'uncommitted',
  'staged',
  'unstaged',
  'branch',
  'commit',
  'files',
] as const

export type Severity = (typeof SEVERITIES)[number]
export type Category = (typeof CATEGORIES)[number]
export type Verdict = (typeof VERDICTS)[number]
export type Confidence = (typeof CONFIDENCES)[number]

export type Finding = {
  file: string
  line?: number
  endLine?: number
  severity: Severity
  category: Category
  title: string
  detail: string
  suggestion?: string
  confidence?: Confidence
}

/** What the Pi agent is asked to emit, after normalisation. */
export type ReviewReport = {
  verdict: Verdict
  summary: string
  findings: Finding[]
}

/**
 * Stats carry no optional members: an `undefined` property would not satisfy
 * the harness's lossless-JSON output node, so absent values are `null`.
 */
export type ReviewStats = {
  filesReviewed: number
  findingsBySeverity: Record<Severity, number>
  durationMs: number
  model: string | null
  provider: string | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd: number
}

/** What the DSH tool returns to the model. */
export type ReviewResult = ReviewReport & {
  scope: string
  files: string[]
  truncated: boolean
  omittedFiles: string[]
  stats: ReviewStats
  /** Present only when the report could not be parsed; holds Pi's raw answer. */
  rawResponse?: string
}

export function severityAtLeast(value: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER.indexOf(value) >= SEVERITY_ORDER.indexOf(floor)
}

export function emptySeverityCounts(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
}
