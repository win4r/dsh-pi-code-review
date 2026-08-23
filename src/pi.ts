import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Event shapes below were captured from `pi --mode json` (v0.84.x) rather than
 * inferred: each line of stdout is one JSON object with a `type` discriminator.
 */
interface PiUsage {
  input?: number
  output?: number
  totalTokens?: number
  cost?: { total?: number }
}

interface PiMessage {
  role?: string
  content?: { type?: string; text?: string }[]
  model?: string
  provider?: string
  usage?: PiUsage
  stopReason?: string
  errorMessage?: string
}

export interface PiRunOptions {
  binary: string
  args: string[]
  prompt: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  /** Registry used to kill stragglers when the plugin unloads. */
  track?: Set<ChildProcess>
}

export interface PiRunResult {
  text: string
  model?: string
  provider?: string
  tokens: { input: number; output: number; total: number }
  costUsd: number
  /** Non-empty when Pi reported a model/provider failure. */
  errors: string[]
  exitCode: number | null
  stderr: string
}

export class PiError extends Error {}

/** Tolerant JSON-lines reader: a malformed or partial line is skipped, not fatal. */
export function parseEventStream(stdout: string): PiRunResult {
  const result: PiRunResult = {
    text: '',
    tokens: { input: 0, output: 0, total: 0 },
    costUsd: 0,
    errors: [],
    exitCode: 0,
    stderr: '',
  }
  const assistantTexts: string[] = []

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }

    // `message_start` carries an empty content array; only `message_end` and
    // `turn_end` hold the settled message, so counting those avoids duplicates.
    if (event.type !== 'message_end') continue
    const msg: PiMessage = event.message ?? {}
    if (msg.role !== 'assistant') continue

    for (const block of msg.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') assistantTexts.push(block.text)
    }
    if (msg.model) result.model = msg.model
    if (msg.provider) result.provider = msg.provider
    if (msg.usage) {
      result.tokens.input += msg.usage.input ?? 0
      result.tokens.output += msg.usage.output ?? 0
      result.tokens.total += msg.usage.totalTokens ?? 0
      result.costUsd += msg.usage.cost?.total ?? 0
    }
    if (msg.stopReason === 'error' && msg.errorMessage) result.errors.push(msg.errorMessage)
  }

  result.text = assistantTexts.join('\n').trim()
  return result
}

export function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(opts.binary, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err: any) {
      reject(new PiError(`failed to spawn "${opts.binary}": ${err?.message ?? err}`))
      return
    }

    opts.track?.add(child)

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    const onAbort = () => child.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      opts.track?.delete(child)
    }

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    child.stdout?.on('data', (c: Buffer) => outChunks.push(c))
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c))
    child.on('error', (err: any) => {
      fail(
        err?.code === 'ENOENT'
          ? new PiError(
              `Pi executable "${opts.binary}" not found. Install it with ` +
                '`npm install -g --ignore-scripts @earendil-works/pi-coding-agent` ' +
                'or set the plugin\'s `binary` option to an absolute path.',
            )
          : new PiError(`Pi process error: ${err?.message ?? err}`),
      )
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()

      const stderr = Buffer.concat(errChunks).toString('utf8')

      // Reject directly rather than through `fail()`: `settled` is already true
      // here, and `fail()` would treat that as "someone else finished this".
      if (timedOut) {
        reject(new PiError(`Pi review timed out after ${opts.timeoutMs}ms.`))
        return
      }
      if (opts.signal?.aborted) {
        reject(new PiError('Pi review was cancelled.'))
        return
      }

      const parsed = parseEventStream(Buffer.concat(outChunks).toString('utf8'))
      parsed.exitCode = code
      parsed.stderr = stderr

      // Pi exits 0 even when the provider call fails, so the exit code alone is
      // not a success signal -- the event stream is the source of truth.
      if (parsed.errors.length) {
        reject(new PiError(`Pi could not complete the review: ${parsed.errors.join('; ')}`))
        return
      }
      if (code !== 0 && !parsed.text) {
        reject(new PiError(`Pi exited with code ${code}. ${stderr.trim().slice(0, 800)}`.trim()))
        return
      }
      if (!parsed.text) {
        reject(new PiError(`Pi returned no assistant output. ${stderr.trim().slice(0, 800)}`.trim()))
        return
      }
      resolve(parsed)
    })

    child.stdin?.on('error', () => {
      /* EPIPE when the child dies early; the close handler reports the reason. */
    })
    child.stdin?.end(opts.prompt, 'utf8')
  })
}

/** Build Pi argv for a headless, single-shot, session-less review run. */
export function buildArgs(input: {
  provider?: string
  model?: string
  thinking?: string
  readOnly: boolean
  readOnlyTools: string[]
  contextFiles: boolean
  extraArgs: string[]
}): string[] {
  const args = ['--mode', 'json', '--print', '--no-session']
  if (input.provider) args.push('--provider', input.provider)
  if (input.model) args.push('--model', input.model)
  if (input.thinking) args.push('--thinking', input.thinking)
  if (input.readOnly && input.readOnlyTools.length) {
    args.push('--tools', input.readOnlyTools.join(','))
  }
  if (!input.contextFiles) args.push('--no-context-files')
  args.push(...input.extraArgs)
  return args
}
