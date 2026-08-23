import type { Payload } from './git.js'
import type { Severity } from './types.js'

export interface PromptInput {
  payload: Payload
  scope: string
  focus?: string
  severityFloor: Severity
  guidelines: string
  canReadWorkspace: boolean
}

const CONTRACT = `{
  "verdict": "approve" | "comment" | "request-changes",
  "summary": "2-4 sentences on what the change does and its overall health",
  "findings": [
    {
      "file": "path/relative/to/repo/root",
      "line": 42,
      "endLine": 45,
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "correctness" | "security" | "performance" | "maintainability" | "testing" | "style" | "docs",
      "title": "one line, imperative",
      "detail": "what is wrong and the concrete conditions under which it breaks",
      "suggestion": "the specific fix",
      "confidence": "high" | "medium" | "low"
    }
  ]
}`

export function buildPrompt(input: PromptInput): string {
  const { payload } = input
  const sections: string[] = []

  sections.push(
    'You are a meticulous senior code reviewer. Review the change below and report only ' +
      'defects you can justify from the code itself.',
  )

  sections.push(
    [
      'Rules:',
      '- Prioritise correctness and security bugs over style. Do not invent issues to fill space; ' +
        'an empty findings list is a valid and welcome answer.',
      '- Every finding must name a concrete failure: the input, state, or sequence that triggers it.',
      '- Anchor each finding to a real path and line from the diff. Use the NEW line numbers.',
      `- Report findings at severity "${input.severityFloor}" or above.`,
      '- Judge the change as written. Do not assume unseen code is broken, and do not ' +
        'flag pre-existing issues outside the change unless the change makes them reachable.',
      input.canReadWorkspace
        ? '- You may use your read-only tools (read, grep, find, ls) to inspect surrounding code ' +
          'before concluding. Verify a suspicion before reporting it.'
        : '- You have no tools available. Reason only from the text below.',
    ].join('\n'),
  )

  if (input.guidelines.trim()) {
    sections.push(`Project review guidelines:\n${input.guidelines.trim()}`)
  }
  if (input.focus?.trim()) {
    sections.push(`Reviewer focus for this run (weight these heavily):\n${input.focus.trim()}`)
  }

  const meta = [`Scope: ${payload.describe}`, `Files in scope: ${payload.files.length}`]
  if (payload.omittedFiles.length) {
    meta.push(
      `Omitted (size budget) -- do NOT comment on these: ${payload.omittedFiles.join(', ')}`,
    )
  }
  sections.push(meta.join('\n'))

  sections.push(`--- BEGIN ${input.scope === 'files' ? 'FILES' : 'DIFF'} ---\n${payload.body}\n--- END ---`)

  sections.push(
    'Reply with a single JSON object in a ```json fenced block and nothing after it. Schema:\n' +
      CONTRACT,
  )

  return sections.join('\n\n')
}

/**
 * Pull the report object out of a free-form answer. Models wrap JSON in prose or
 * fences unpredictably, so try fenced blocks first, then brace-match the tail.
 */
export function extractJson(text: string): unknown | undefined {
  const fenced = [...text.matchAll(/```(?:json|jsonc)?\s*\n([\s\S]*?)```/gi)]
  for (const match of fenced.reverse()) {
    const parsed = tryParse(match[1])
    if (parsed !== undefined) return parsed
  }
  for (const candidate of balancedObjects(text).reverse()) {
    const parsed = tryParse(candidate)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function tryParse(raw: string): unknown | undefined {
  try {
    const value = JSON.parse(raw.trim())
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/** Every top-level {...} run, string- and escape-aware. */
function balancedObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      } else if (depth < 0) depth = 0
    }
  }
  return out
}
