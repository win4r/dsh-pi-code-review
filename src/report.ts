import {
  CATEGORIES,
  SEVERITIES,
  SEVERITY_ORDER,
  VERDICTS,
  emptySeverityCounts,
  severityAtLeast,
  type Category,
  type Finding,
  type ReviewResult,
  type ReviewReport,
  type Severity,
  type Verdict,
} from './types.js'

function asSeverity(value: unknown): Severity {
  const v = String(value ?? '').toLowerCase().trim()
  if ((SEVERITIES as readonly string[]).includes(v)) return v as Severity
  if (v === 'blocker' || v === 'fatal') return 'critical'
  if (v === 'major' || v === 'warning' || v === 'warn') return 'high'
  if (v === 'minor' || v === 'nit' || v === 'nitpick') return 'low'
  return 'medium'
}

function asCategory(value: unknown): Category {
  const v = String(value ?? '').toLowerCase().trim()
  if ((CATEGORIES as readonly string[]).includes(v)) return v as Category
  if (v === 'bug' || v === 'logic') return 'correctness'
  if (v === 'perf') return 'performance'
  if (v === 'test' || v === 'tests') return 'testing'
  if (v === 'documentation') return 'docs'
  return 'maintainability'
}

function asLine(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Coerce whatever the model produced into the canonical report. Anything
 * unrecognised is normalised rather than rejected -- a slightly off-schema
 * review is still worth surfacing.
 */
export function normaliseReport(raw: unknown, floor: Severity): ReviewReport {
  const obj = (raw ?? {}) as Record<string, unknown>

  const rawFindings = Array.isArray(obj.findings)
    ? obj.findings
    : Array.isArray(obj.issues)
      ? obj.issues
      : []

  const findings: Finding[] = []
  for (const entry of rawFindings) {
    if (!entry || typeof entry !== 'object') continue
    const f = entry as Record<string, unknown>
    const title = asText(f.title) || asText(f.summary) || asText(f.message)
    const detail = asText(f.detail) || asText(f.description) || asText(f.explanation)
    if (!title && !detail) continue

    const severity = asSeverity(f.severity ?? f.level ?? f.priority)
    if (!severityAtLeast(severity, floor)) continue

    const confidenceRaw = String(f.confidence ?? '').toLowerCase().trim()
    const finding: Finding = {
      file: asText(f.file) || asText(f.path) || 'unknown',
      severity,
      category: asCategory(f.category ?? f.type),
      title: title || detail.slice(0, 120),
      detail: detail || title,
    }
    const line = asLine(f.line ?? f.startLine ?? f.lineNumber)
    if (line !== undefined) finding.line = line
    const endLine = asLine(f.endLine ?? f.lineEnd)
    if (endLine !== undefined && (line === undefined || endLine >= line)) finding.endLine = endLine
    const suggestion = asText(f.suggestion ?? f.fix ?? f.recommendation)
    if (suggestion) finding.suggestion = suggestion
    if (confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low') {
      finding.confidence = confidenceRaw
    }
    findings.push(finding)
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  )

  const verdictRaw = String(obj.verdict ?? obj.decision ?? '').toLowerCase().trim()
  let verdict: Verdict
  if ((VERDICTS as readonly string[]).includes(verdictRaw)) {
    verdict = verdictRaw as Verdict
  } else if (verdictRaw === 'approved' || verdictRaw === 'lgtm') {
    verdict = 'approve'
  } else if (verdictRaw.includes('change') || verdictRaw === 'reject') {
    verdict = 'request-changes'
  } else {
    // Derive from severity when the model omitted or mangled the verdict.
    verdict = findings.some((f) => f.severity === 'critical' || f.severity === 'high')
      ? 'request-changes'
      : findings.length
        ? 'comment'
        : 'approve'
  }

  return {
    verdict,
    summary: asText(obj.summary) || asText(obj.overview) || 'No summary provided.',
    findings,
  }
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts = emptySeverityCounts()
  for (const f of findings) counts[f.severity]++
  return counts
}

const ICONS: Record<Severity, string> = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  info: 'ℹ️',
}

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: '✅ Approve',
  comment: '💬 Comment',
  'request-changes': '⛔ Request changes',
}

/** Human-readable rendering handed back to the harness model. */
export function renderReport(value: ReviewResult): string {
  const lines: string[] = []
  lines.push(`## Pi code review — ${VERDICT_LABEL[value.verdict]}`)
  lines.push('')
  lines.push(value.summary)
  lines.push('')

  const counts = countBySeverity(value.findings)
  const tally = SEVERITIES.slice()
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(', ')
  lines.push(
    `**Scope:** ${value.scope} · **Files:** ${value.files.length} · ` +
      `**Findings:** ${value.findings.length}${tally ? ` (${tally})` : ''}`,
  )
  if (value.truncated) {
    lines.push('')
    lines.push(
      `> ⚠️ Not everything was reviewed. Omitted for size: ${value.omittedFiles.join(', ')}`,
    )
  }
  lines.push('')

  if (!value.findings.length) {
    lines.push('_No findings at or above the requested severity._')
  }
  for (const f of value.findings) {
    const loc = f.line ? `${f.file}:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ''}` : f.file
    const confidence = f.confidence ? ` · confidence: ${f.confidence}` : ''
    lines.push(`### ${ICONS[f.severity]} ${f.title}`)
    lines.push(`\`${loc}\` · ${f.severity} · ${f.category}${confidence}`)
    lines.push('')
    lines.push(f.detail)
    if (f.suggestion) {
      lines.push('')
      lines.push(`**Suggested fix:** ${f.suggestion}`)
    }
    lines.push('')
  }

  if (value.rawResponse) {
    lines.push('---')
    lines.push('> Pi did not return parseable JSON. Raw answer:')
    lines.push('')
    lines.push(value.rawResponse.slice(0, 4000))
    lines.push('')
  }

  const secs = (value.stats.durationMs / 1000).toFixed(1)
  const cost = value.stats.costUsd ? ` · $${value.stats.costUsd.toFixed(4)}` : ''
  lines.push(`_Reviewed by Pi${value.stats.model ? ` (${value.stats.model})` : ''} in ${secs}s${cost}._`)
  return lines.join('\n')
}
