import type { ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config } from './config.js'
import { collectPayload, GitError, type ReviewScope } from './git.js'
import { buildArgs, PiError, runPi } from './pi.js'
import { buildPrompt, extractJson } from './prompt.js'
import { countBySeverity, normaliseReport, renderReport } from './report.js'
import {
  CATEGORIES,
  CONFIDENCES,
  SCOPES,
  SEVERITIES,
  VERDICTS,
  emptySeverityCounts,
  type ReviewResult,
  type Severity,
} from './types.js'

export { Config }
export const name = 'dsh-pi-review'
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const log = getLogger(ctx)

  // Pi runs as an external process: a plugin unload (HMR, config edit) must not
  // leave orphans behind holding a paid provider session open.
  const running = new Set<ChildProcess>()
  ctx.effect(() => () => {
    for (const child of running) child.kill('SIGKILL')
    running.clear()
  })

  ctx.tools.register(
    defineTool({
      name: 'pi_code_review',
      description:
        'Run a code review with the Pi coding agent. Reviews a git diff (uncommitted, staged, ' +
        'branch-vs-base, or a single commit) or the full contents of specific files, and returns ' +
        'structured findings with severity, category, file and line. Use this when the user asks ' +
        'for a code review, a second opinion on a change, or a pre-commit / pre-PR check.',

      parameters: {
        scope: {
          type: 'string',
          enum: SCOPES,
          description:
            'What to review. "uncommitted" (default) = git diff HEAD; "staged" = git diff --cached; ' +
            '"unstaged" = git diff; "branch" = diff against baseRef via its merge base; ' +
            '"commit" = a single commit (headRef); "files" = full contents of `paths`.',
        },
        baseRef: {
          type: 'string',
          description: 'Base ref for scope "branch". Defaults to the plugin\'s configured defaultBaseRef.',
        },
        headRef: {
          type: 'string',
          description:
            'Head ref for scope "branch", or the commit to review for scope "commit". Defaults to HEAD.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Repo-relative paths. Required for scope "files"; optional elsewhere to narrow the diff.',
        },
        focus: {
          type: 'string',
          description:
            'Extra emphasis for this run, e.g. "concurrency and error handling" or "check the SQL for injection".',
        },
        severityFloor: {
          type: 'string',
          enum: SEVERITIES,
          description: 'Lowest severity worth reporting. Defaults to "low".',
        },
        model: {
          type: 'string',
          description: 'Override the configured Pi model for this run.',
        },
        cwd: {
          type: 'string',
          description: 'Directory to run in. Defaults to the harness working directory.',
        },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', enum: VERDICTS, required: true },
            summary: { type: 'string', required: true },
            findings: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  file: { type: 'string', required: true },
                  line: { type: 'number' },
                  endLine: { type: 'number' },
                  severity: { type: 'string', enum: SEVERITIES, required: true },
                  category: { type: 'string', enum: CATEGORIES, required: true },
                  title: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                  suggestion: { type: 'string' },
                  confidence: { type: 'string', enum: CONFIDENCES },
                },
              },
            },
            scope: { type: 'string', required: true },
            files: { type: 'array', items: { type: 'string' }, required: true },
            truncated: { type: 'boolean', required: true },
            omittedFiles: { type: 'array', items: { type: 'string' }, required: true },
            stats: { type: 'json', required: true },
            rawResponse: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: renderReport(value as ReviewResult) },
        ],
      },

      // Reviews are pure reads, so several may safely overlap.
      isConcurrencySafe: () => true,

      async execute(args, exec: ToolRunContext): Promise<ReviewResult> {
        const started = Date.now()
        const signal = exec.signal
        const scope = (args.scope ?? 'uncommitted') as ReviewScope
        const severityFloor = (args.severityFloor ?? 'low') as Severity
        const cwd = args.cwd || process.cwd()

        let payload
        try {
          payload = await collectPayload({
            cwd,
            scope,
            baseRef: args.baseRef || config.defaultBaseRef,
            headRef: args.headRef,
            paths: args.paths,
            maxDiffBytes: config.maxDiffBytes,
            maxFileBytes: config.maxFileBytes,
            includeUntracked: config.includeUntracked,
            signal,
          })
        } catch (err) {
          if (err instanceof GitError) throw new Error(`Could not collect the change: ${err.message}`)
          throw err
        }

        if (!payload.body.trim()) {
          return {
            verdict: 'approve',
            summary: `Nothing to review: no changes found for scope "${scope}".`,
            findings: [],
            scope: payload.describe,
            files: [],
            truncated: false,
            omittedFiles: [],
            stats: {
              filesReviewed: 0,
              findingsBySeverity: emptySeverityCounts(),
              durationMs: Date.now() - started,
              model: null,
              provider: null,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              costUsd: 0,
            },
          }
        }

        const prompt = buildPrompt({
          payload,
          scope,
          focus: args.focus,
          severityFloor,
          guidelines: config.guidelines,
          canReadWorkspace: !config.readOnly || config.readOnlyTools.length > 0,
        })

        const piArgs = buildArgs({
          provider: config.provider,
          model: args.model || config.model,
          thinking: config.thinking,
          readOnly: config.readOnly,
          readOnlyTools: config.readOnlyTools,
          contextFiles: config.contextFiles,
          extraArgs: config.extraArgs,
        })

        log.debug?.(`pi_code_review: scope=${scope} files=${payload.files.length}`)

        let run
        try {
          run = await runPi({
            binary: config.binary,
            args: piArgs,
            prompt,
            cwd,
            env: { ...process.env, ...config.env, PI_SKIP_VERSION_CHECK: '1' },
            timeoutMs: config.timeoutMs,
            signal,
            track: running,
          })
        } catch (err) {
          if (err instanceof PiError) throw new Error(err.message)
          throw err
        }

        const parsed = extractJson(run.text)
        const report = normaliseReport(parsed, severityFloor)

        const result: ReviewResult = {
          ...report,
          scope: payload.describe,
          files: payload.files,
          truncated: payload.truncated,
          omittedFiles: payload.omittedFiles,
          stats: {
            filesReviewed: payload.files.length,
            findingsBySeverity: countBySeverity(report.findings),
            durationMs: Date.now() - started,
            model: run.model ?? null,
            provider: run.provider ?? null,
            inputTokens: run.tokens.input,
            outputTokens: run.tokens.output,
            totalTokens: run.tokens.total,
            costUsd: run.costUsd,
          },
        }

        // Surface the raw answer rather than silently reporting "no findings"
        // when Pi replied with prose instead of the requested JSON.
        if (parsed === undefined) result.rawResponse = run.text

        return result
      },
    }),
  )

  log.info?.(`dsh-pi-review ready (binary: ${config.binary}, thinking: ${config.thinking})`)
}

/** Cordis exposes ctx.logger, but keep the plugin usable if it is absent. */
function getLogger(ctx: unknown) {
  const candidate = (ctx as { logger?: unknown }).logger
  try {
    const logger = typeof candidate === 'function' ? candidate('pi-review') : candidate
    if (logger && typeof (logger as { info?: unknown }).info === 'function') {
      return logger as Record<string, ((msg: string) => void) | undefined>
    }
  } catch {
    /* fall through to the console shim */
  }
  return {
    info: (m: string) => console.log(`[pi-review] ${m}`),
    warn: (m: string) => console.warn(`[pi-review] ${m}`),
    error: (m: string) => console.error(`[pi-review] ${m}`),
    debug: undefined,
  }
}
