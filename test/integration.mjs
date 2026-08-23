/**
 * End-to-end check against a real `pi` binary and a real provider.
 * Not part of `npm test` -- it costs tokens. Run explicitly:
 *   node test/integration.mjs [--provider <name>] [--model <pattern>]
 *
 * With no flags it passes neither --provider nor --model, exercising the normal
 * path where Pi resolves its own default provider, model, and authentication.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { collectPayload } from '../dist/git.js'
import { buildArgs, runPi } from '../dist/pi.js'
import { buildPrompt, extractJson } from '../dist/prompt.js'
import { normaliseReport, renderReport, countBySeverity } from '../dist/report.js'

const exec = promisify(execFile)
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const provider = arg('provider', undefined)
const model = arg('model', undefined)

// A tiny repo whose committed version is correct and whose working-tree change
// introduces one unmistakable bug, plus one new untracked file with another.
const BEFORE = `export function averageScore(scores) {
  if (scores.length === 0) return 0
  let total = 0
  for (const s of scores) total += s
  return total / scores.length
}
`
const AFTER = `export function averageScore(scores) {
  let total = 0
  for (const s of scores) total += s
  return total / scores.length
}
`
const UNTRACKED = `export function pickUser(db, name) {
  return db.query("SELECT * FROM users WHERE name = '" + name + "'")
}
`

const root = await mkdtemp(path.join(tmpdir(), 'pi-review-e2e-'))
const git = (...args) => exec('git', args, { cwd: root })

await git('init', '-q')
await git('config', 'user.email', 'e2e@example.com')
await git('config', 'user.name', 'E2E')
await writeFile(path.join(root, 'scores.js'), BEFORE)
await git('add', '-A')
await git('commit', '-qm', 'initial')

await writeFile(path.join(root, 'scores.js'), AFTER)
await writeFile(path.join(root, 'users.js'), UNTRACKED)

console.log(`repo:     ${root}`)
console.log(`provider: ${provider ?? "(pi default)"}  model: ${model ?? "(pi default)"}\n`)

const payload = await collectPayload({
  cwd: root,
  scope: 'uncommitted',
  maxDiffBytes: 240_000,
  maxFileBytes: 80_000,
  includeUntracked: true,
})

console.log(`scope:    ${payload.describe}`)
console.log(`files:    ${JSON.stringify(payload.files)}`)
if (!payload.files.includes('users.js')) {
  throw new Error('FAIL: untracked file was not picked up by the diff collector')
}

const prompt = buildPrompt({
  payload,
  scope: 'uncommitted',
  severityFloor: 'low',
  guidelines: '',
  canReadWorkspace: true,
})

const started = Date.now()
const run = await runPi({
  binary: 'pi',
  args: buildArgs({
    provider,
    model,
    thinking: 'medium',
    readOnly: true,
    readOnlyTools: ['read', 'grep', 'find', 'ls'],
    contextFiles: false,
    extraArgs: [],
  }),
  prompt,
  cwd: root,
  env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' },
  timeoutMs: 600_000,
})

const parsed = extractJson(run.text)
if (parsed === undefined) {
  console.error('FAIL: could not parse a JSON report. Raw answer:\n')
  console.error(run.text.slice(0, 2000))
  process.exit(1)
}

const report = normaliseReport(parsed, 'low')
const result = {
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

console.log(`\n${'='.repeat(70)}\n`)
console.log(renderReport(result))
console.log(`\n${'='.repeat(70)}\n`)

// The planted bugs are blatant; a review that misses both is a real failure.
const text = JSON.stringify(result.findings).toLowerCase()
const caughtDivZero =
  /scores\.js/.test(text) && /(empty|zero|divide|division|nan|length === 0)/.test(text)
const caughtSqli = /users\.js/.test(text) && /(inject|sqli|sql injection|paramet)/.test(text)

console.log(`findings:             ${result.findings.length}`)
console.log(`caught div-by-zero:   ${caughtDivZero ? 'yes' : 'NO'}`)
console.log(`caught SQL injection: ${caughtSqli ? 'yes' : 'NO'}`)
console.log(`verdict:              ${result.verdict}`)
console.log(`tokens/cost:          ${result.stats.totalTokens} / $${result.stats.costUsd.toFixed(4)}`)

if (!caughtDivZero || !caughtSqli) {
  console.error('\nFAIL: the review missed a planted bug.')
  process.exit(1)
}
console.log('\nPASS: end-to-end review works.')
