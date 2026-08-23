import Schema from '@deepseek-ai/schemastery'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Config {
  /** Pi executable. An absolute path avoids depending on the harness PATH. */
  binary: string
  /** Extra argv appended verbatim to every Pi invocation. */
  extraArgs: string[]
  /** Extra environment for the Pi process (PI_* flags such as PI_OFFLINE). */
  env: Record<string, string>

  /** Leave unset to inherit Pi's own configured provider, along with its auth. */
  provider?: string
  /** Leave unset to inherit Pi's own configured model. */
  model?: string
  thinking: ThinkingLevel

  /**
   * Restrict Pi to non-mutating tools. A reviewer that can edit the workspace
   * is a footgun: Pi ships no permission sandbox of its own.
   */
  readOnly: boolean
  /** Tool allowlist used when `readOnly` is true. */
  readOnlyTools: string[]
  /** Load AGENTS.md / CLAUDE.md from the workspace into Pi's context. */
  contextFiles: boolean

  timeoutMs: number
  /** Byte ceiling for the diff handed to Pi; whole files are dropped past it. */
  maxDiffBytes: number
  /** Per-file byte ceiling when reviewing whole files. */
  maxFileBytes: number
  defaultBaseRef: string
  includeUntracked: boolean
  /** Standing review instructions prepended to every request. */
  guidelines: string
}

export const Config: Schema<Config> = Schema.object({
  binary: Schema.string()
    .default('pi')
    .description('Path to the Pi coding-agent executable.'),
  extraArgs: Schema.array(Schema.string())
    .default([])
    .description('Additional CLI arguments passed to every Pi invocation.'),
  env: Schema.dict(Schema.string())
    .default({})
    .description(
      'Extra environment for the Pi process, e.g. PI_OFFLINE or PI_CACHE_RETENTION. ' +
      'Credentials do not belong here: Pi resolves its own auth.',
    ),

  provider: Schema.string()
    .description(
      'Pi provider name. Leave unset to use Pi\'s own configured default, which also ' +
      'carries its authentication.',
    ),
  model: Schema.string()
    .description('Pi model pattern. Leave unset to use Pi\'s own configured default.'),
  thinking: Schema.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
    .default('high')
    .description('Pi reasoning level. Review quality is sensitive to this.'),

  readOnly: Schema.boolean()
    .default(true)
    .description('Restrict Pi to read-only tools so a review can never mutate the workspace.'),
  readOnlyTools: Schema.array(Schema.string())
    .default(['read', 'grep', 'find', 'ls'])
    .description('Tool allowlist applied when readOnly is enabled.'),
  contextFiles: Schema.boolean()
    .default(true)
    .description('Let Pi load AGENTS.md / CLAUDE.md so reviews respect project conventions.'),

  timeoutMs: Schema.number()
    .min(10_000)
    .default(600_000)
    .description('Hard wall-clock limit for one review.'),
  maxDiffBytes: Schema.number()
    .min(1_000)
    .default(240_000)
    .description('Diff size ceiling. Files past the budget are omitted and reported.'),
  maxFileBytes: Schema.number()
    .min(1_000)
    .default(80_000)
    .description('Per-file ceiling when reviewing whole files rather than a diff.'),
  defaultBaseRef: Schema.string()
    .default('origin/main')
    .description('Base ref for scope "branch" when the caller does not supply one.'),
  includeUntracked: Schema.boolean()
    .default(true)
    .description('Synthesise diffs for untracked files, which git diff would skip.'),
  guidelines: Schema.string()
    .role('textarea')
    .default('')
    .description('Standing review instructions prepended to every request.'),
})
