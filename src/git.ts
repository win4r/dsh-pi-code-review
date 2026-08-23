import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type ReviewScope = 'uncommitted' | 'staged' | 'unstaged' | 'branch' | 'commit' | 'files'

export interface CollectOptions {
  cwd: string
  scope: ReviewScope
  baseRef?: string
  headRef?: string
  paths?: string[]
  maxDiffBytes: number
  maxFileBytes: number
  includeUntracked: boolean
  signal?: AbortSignal
}

export interface Payload {
  /** Unified diff (or annotated file bodies for scope "files"). */
  body: string
  files: string[]
  omittedFiles: string[]
  truncated: boolean
  describe: string
}

export class GitError extends Error {}

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      signal,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err
    const detail = String(err?.stderr || err?.message || err).trim()
    throw new GitError(`git ${args.join(' ')} failed: ${detail}`)
  }
}

export async function repoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const out = await git(['rev-parse', '--show-toplevel'], cwd, signal)
  return out.trim()
}

/** Resolve `base...head` through the merge base, matching PR review semantics. */
async function mergeBase(base: string, head: string, cwd: string, signal?: AbortSignal) {
  try {
    return (await git(['merge-base', base, head], cwd, signal)).trim()
  } catch {
    return base
  }
}

/**
 * `git diff` cannot see untracked files, so a review of "what I changed" would
 * silently skip brand-new files. Synthesise a diff for each one instead.
 */
async function untrackedDiff(cwd: string, paths: string[], signal?: AbortSignal): Promise<string> {
  const args = ['ls-files', '--others', '--exclude-standard']
  if (paths.length) args.push('--', ...paths)
  const listing = (await git(args, cwd, signal)).split('\n').map((l) => l.trim()).filter(Boolean)

  const chunks: string[] = []
  for (const file of listing) {
    // --no-index exits non-zero when the files differ, which is always true
    // against /dev/null -- the diff we want is on stdout regardless.
    try {
      const { stdout } = await exec(
        'git',
        ['diff', '--no-index', '--', '/dev/null', file],
        { cwd, signal, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      )
      if (stdout) chunks.push(stdout)
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err
      if (typeof err?.stdout === 'string' && err.stdout.length) chunks.push(err.stdout)
    }
  }
  return chunks.join('')
}

/** Split a unified diff into per-file sections keyed by path. */
export function splitDiff(diff: string): { file: string; text: string }[] {
  if (!diff.trim()) return []
  const sections: { file: string; text: string }[] = []
  const lines = diff.split('\n')
  let current: string[] = []
  let name = 'unknown'

  const flush = () => {
    if (current.length) sections.push({ file: name, text: current.join('\n') })
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush()
      current = [line]
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      name = m ? m[2] : line.slice('diff --git '.length)
    } else {
      current.push(line)
    }
  }
  flush()
  return sections
}

/** Keep whole files until the byte budget runs out; report what was dropped. */
function applyBudget(sections: { file: string; text: string }[], budget: number) {
  const kept: string[] = []
  const files: string[] = []
  const omittedFiles: string[] = []
  let used = 0

  for (const section of sections) {
    const size = Buffer.byteLength(section.text, 'utf8') + 1
    if (used + size > budget && kept.length > 0) {
      omittedFiles.push(section.file)
      continue
    }
    if (used + size > budget && kept.length === 0) {
      // A single file larger than the whole budget: include a hard-cut prefix
      // rather than returning nothing at all.
      const slice = Buffer.from(section.text, 'utf8').subarray(0, budget).toString('utf8')
      kept.push(`${slice}\n... [truncated: ${section.file} exceeds maxDiffBytes]`)
      files.push(section.file)
      used = budget
      continue
    }
    kept.push(section.text)
    files.push(section.file)
    used += size
  }

  return { body: kept.join('\n'), files, omittedFiles, truncated: omittedFiles.length > 0 }
}

async function readWholeFiles(opts: CollectOptions, root: string): Promise<Payload> {
  const requested = opts.paths ?? []
  if (!requested.length) throw new GitError('scope "files" requires a non-empty `paths` argument.')

  const parts: string[] = []
  const files: string[] = []
  const omittedFiles: string[] = []
  let used = 0

  for (const rel of requested) {
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      omittedFiles.push(`${rel} (outside repository)`)
      continue
    }
    let body: string
    try {
      const info = await stat(abs)
      if (!info.isFile()) {
        omittedFiles.push(`${rel} (not a regular file)`)
        continue
      }
      body = await readFile(abs, 'utf8')
    } catch {
      omittedFiles.push(`${rel} (unreadable)`)
      continue
    }
    if (Buffer.byteLength(body, 'utf8') > opts.maxFileBytes) {
      body = `${body.slice(0, opts.maxFileBytes)}\n... [truncated at maxFileBytes]`
    }
    const block = `--- FILE: ${rel} ---\n${body}`
    const size = Buffer.byteLength(block, 'utf8')
    if (used + size > opts.maxDiffBytes && parts.length) {
      omittedFiles.push(`${rel} (diff budget exhausted)`)
      continue
    }
    parts.push(block)
    files.push(rel)
    used += size
  }

  return {
    body: parts.join('\n\n'),
    files,
    omittedFiles,
    truncated: omittedFiles.length > 0,
    describe: `full contents of ${files.length} file(s)`,
  }
}

export async function collectPayload(opts: CollectOptions): Promise<Payload> {
  const root = await repoRoot(opts.cwd, opts.signal)
  if (opts.scope === 'files') return readWholeFiles(opts, root)

  const pathArgs = opts.paths?.length ? ['--', ...opts.paths] : []
  let raw = ''
  let describe = ''

  switch (opts.scope) {
    case 'staged':
      raw = await git(['diff', '--cached', ...pathArgs], root, opts.signal)
      describe = 'staged changes (git diff --cached)'
      break
    case 'unstaged':
      raw = await git(['diff', ...pathArgs], root, opts.signal)
      describe = 'unstaged working-tree changes (git diff)'
      break
    case 'uncommitted':
      raw = await git(['diff', 'HEAD', ...pathArgs], root, opts.signal)
      describe = 'all uncommitted changes (git diff HEAD)'
      break
    case 'commit': {
      const ref = opts.headRef || 'HEAD'
      raw = await git(['show', '--format=medium', ref, ...pathArgs], root, opts.signal)
      describe = `commit ${ref}`
      break
    }
    case 'branch': {
      const base = opts.baseRef!
      const head = opts.headRef || 'HEAD'
      const mb = await mergeBase(base, head, root, opts.signal)
      raw = await git(['diff', `${mb}..${head}`, ...pathArgs], root, opts.signal)
      describe = `branch changes ${base}...${head} (merge base ${mb.slice(0, 12)})`
      break
    }
  }

  if (opts.includeUntracked && (opts.scope === 'uncommitted' || opts.scope === 'unstaged')) {
    const extra = await untrackedDiff(root, opts.paths ?? [], opts.signal)
    if (extra.trim()) raw = raw ? `${raw}\n${extra}` : extra
  }

  const budgeted = applyBudget(splitDiff(raw), opts.maxDiffBytes)
  return { ...budgeted, describe }
}
