import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseEventStream, buildArgs } from '../dist/pi.js'
import { extractJson, buildPrompt } from '../dist/prompt.js'
import { normaliseReport, countBySeverity, renderReport } from '../dist/report.js'
import { splitDiff } from '../dist/git.js'

// --- pi.ts: event stream parsing (shapes captured from a real `pi --mode json` run)

const OK_STREAM = [
  '{"type":"session","version":3,"id":"abc","cwd":"/tmp"}',
  '{"type":"agent_start"}',
  '{"type":"message_start","message":{"role":"assistant","content":[]}}',
  '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"prompt echo"}]}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"model":"m1","provider":"p1","usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.02}}}}',
  '{"type":"agent_settled"}',
].join('\n')

test('parseEventStream collects assistant text, model and usage', () => {
  const r = parseEventStream(OK_STREAM)
  assert.equal(r.text, 'hello')
  assert.equal(r.model, 'm1')
  assert.equal(r.provider, 'p1')
  assert.deepEqual(r.tokens, { input: 10, output: 5, total: 15 })
  assert.equal(r.costUsd, 0.02)
  assert.deepEqual(r.errors, [])
})

test('parseEventStream ignores the user echo so the prompt never leaks into the answer', () => {
  assert.ok(!parseEventStream(OK_STREAM).text.includes('prompt echo'))
})

test('parseEventStream surfaces provider errors that pi reports with exit code 0', () => {
  const stream =
    '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"OpenAI API error (401): bad key"}}'
  const r = parseEventStream(stream)
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /401/)
})

test('parseEventStream tolerates malformed and partial lines', () => {
  const r = parseEventStream(`not json\n{"broken":\n${OK_STREAM}\n{"type":`)
  assert.equal(r.text, 'hello')
})

test('buildArgs produces a headless, session-less, read-only invocation', () => {
  const args = buildArgs({
    model: 'sonnet',
    thinking: 'high',
    readOnly: true,
    readOnlyTools: ['read', 'grep'],
    contextFiles: false,
    extraArgs: ['--offline'],
  })
  assert.deepEqual(args, [
    '--mode', 'json', '--print', '--no-session',
    '--model', 'sonnet',
    '--thinking', 'high',
    '--tools', 'read,grep',
    '--no-context-files',
    '--offline',
  ])
})

test('buildArgs omits the tool allowlist when readOnly is disabled', () => {
  const args = buildArgs({ readOnly: false, readOnlyTools: ['read'], contextFiles: true, extraArgs: [] })
  assert.ok(!args.includes('--tools'))
  assert.ok(!args.includes('--no-context-files'))
})

// --- prompt.ts: pulling JSON back out of a free-form answer

test('extractJson reads a fenced json block', () => {
  const value = extractJson('Sure!\n```json\n{"verdict":"approve","findings":[]}\n```\nDone.')
  assert.equal(value.verdict, 'approve')
})

test('extractJson falls back to a bare object when the model skips the fence', () => {
  const value = extractJson('Here it is: {"verdict":"comment","findings":[]} hope that helps')
  assert.equal(value.verdict, 'comment')
})

test('extractJson is not fooled by braces inside strings', () => {
  const value = extractJson('```json\n{"summary":"use { and } carefully","findings":[]}\n```')
  assert.equal(value.summary, 'use { and } carefully')
})

test('extractJson prefers the last block when the model shows an example first', () => {
  const text = '```json\n{"summary":"EXAMPLE"}\n```\nActual:\n```json\n{"summary":"REAL"}\n```'
  assert.equal(extractJson(text).summary, 'REAL')
})

test('extractJson returns undefined for prose with no JSON', () => {
  assert.equal(extractJson('I could not review this change.'), undefined)
})

test('buildPrompt embeds the diff, the floor, and warns off omitted files', () => {
  const prompt = buildPrompt({
    payload: {
      body: 'diff --git a/x b/x\n+bad()',
      files: ['x'],
      omittedFiles: ['huge.lock'],
      truncated: true,
      describe: 'staged changes',
    },
    scope: 'staged',
    focus: 'security',
    severityFloor: 'medium',
    guidelines: 'No new deps.',
    canReadWorkspace: true,
  })
  assert.match(prompt, /\+bad\(\)/)
  assert.match(prompt, /severity "medium"/)
  assert.match(prompt, /do NOT comment on these: huge\.lock/)
  assert.match(prompt, /No new deps\./)
  assert.match(prompt, /security/)
})

// --- report.ts: normalising whatever the model actually produced

test('normaliseReport keeps well-formed findings and sorts by severity', () => {
  const report = normaliseReport(
    {
      verdict: 'request-changes',
      summary: 'Two problems.',
      findings: [
        { file: 'a.ts', line: 3, severity: 'low', category: 'style', title: 'nit', detail: 'd' },
        { file: 'b.ts', line: 9, severity: 'critical', category: 'security', title: 'sqli', detail: 'd' },
      ],
    },
    'info',
  )
  assert.equal(report.verdict, 'request-changes')
  assert.deepEqual(report.findings.map((f) => f.severity), ['critical', 'low'])
})

test('normaliseReport drops findings below the severity floor', () => {
  const report = normaliseReport(
    {
      findings: [
        { file: 'a', severity: 'low', title: 't', detail: 'd' },
        { file: 'b', severity: 'high', title: 't', detail: 'd' },
      ],
    },
    'high',
  )
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].file, 'b')
})

test('normaliseReport maps synonym severities and categories', () => {
  const report = normaliseReport(
    { findings: [{ file: 'a', severity: 'blocker', category: 'bug', title: 't', detail: 'd' }] },
    'info',
  )
  assert.equal(report.findings[0].severity, 'critical')
  assert.equal(report.findings[0].category, 'correctness')
})

test('normaliseReport accepts alternate field names', () => {
  const report = normaliseReport(
    { issues: [{ path: 'a.ts', level: 'major', message: 'boom', description: 'why', fix: 'do x' }] },
    'info',
  )
  assert.equal(report.findings[0].file, 'a.ts')
  assert.equal(report.findings[0].severity, 'high')
  assert.equal(report.findings[0].suggestion, 'do x')
})

test('normaliseReport derives a verdict when the model omits one', () => {
  assert.equal(normaliseReport({ findings: [] }, 'info').verdict, 'approve')
  assert.equal(
    normaliseReport({ findings: [{ file: 'a', severity: 'critical', title: 't', detail: 'd' }] }, 'info').verdict,
    'request-changes',
  )
  assert.equal(
    normaliseReport({ findings: [{ file: 'a', severity: 'low', title: 't', detail: 'd' }] }, 'info').verdict,
    'comment',
  )
})

test('normaliseReport survives garbage input', () => {
  for (const bad of [undefined, null, 42, 'nope', { findings: 'no' }, { findings: [null, 7, {}] }]) {
    const report = normaliseReport(bad, 'info')
    assert.ok(Array.isArray(report.findings))
    assert.equal(typeof report.summary, 'string')
  }
})

test('countBySeverity tallies every bucket', () => {
  const counts = countBySeverity([{ severity: 'high' }, { severity: 'high' }, { severity: 'info' }])
  assert.equal(counts.high, 2)
  assert.equal(counts.info, 1)
  assert.equal(counts.critical, 0)
})

test('renderReport shows the verdict, locations and a truncation warning', () => {
  const md = renderReport({
    verdict: 'request-changes',
    summary: 'Needs work.',
    findings: [
      { file: 'a.ts', line: 4, endLine: 9, severity: 'high', category: 'correctness', title: 'Null deref', detail: 'x is null', suggestion: 'guard it' },
    ],
    scope: 'staged changes',
    files: ['a.ts'],
    truncated: true,
    omittedFiles: ['big.lock'],
    stats: { durationMs: 4200, model: 'sonnet', costUsd: 0.031, filesReviewed: 1, findingsBySeverity: {}, provider: 'anthropic', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  })
  assert.match(md, /Request changes/)
  assert.match(md, /a\.ts:4-9/)
  assert.match(md, /guard it/)
  assert.match(md, /big\.lock/)
  assert.match(md, /4\.2s/)
})

test('renderReport says so plainly when there are no findings', () => {
  const md = renderReport({
    verdict: 'approve', summary: 'Clean.', findings: [], scope: 's', files: [],
    truncated: false, omittedFiles: [],
    stats: { durationMs: 100, model: null, costUsd: 0, filesReviewed: 0, findingsBySeverity: {}, provider: null, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  })
  assert.match(md, /No findings/)
})

// --- git.ts: diff splitting

test('splitDiff separates per-file sections and reads the new path', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/b.ts b/src/b.ts',
    '+added',
  ].join('\n')
  const sections = splitDiff(diff)
  assert.deepEqual(sections.map((s) => s.file), ['src/a.ts', 'src/b.ts'])
  assert.match(sections[0].text, /\+new/)
})

test('splitDiff returns nothing for an empty diff', () => {
  assert.deepEqual(splitDiff('   \n'), [])
})

// --- config.ts: Schemastery schema must apply defaults and fail loudly

import { Config } from '../dist/config.js'

test('Config supplies defaults for an empty cordis.yml block', () => {
  const c = new Config({})
  assert.equal(c.binary, 'pi')
  assert.equal(c.thinking, 'high')
  assert.equal(c.readOnly, true)
  assert.deepEqual(c.readOnlyTools, ['read', 'grep', 'find', 'ls'])
  assert.equal(c.includeUntracked, true)
})

test('Config leaves provider and model unset so Pi supplies its own defaults and auth', () => {
  const c = new Config({})
  assert.equal(c.provider, undefined)
  assert.equal(c.model, undefined)
  assert.deepEqual(buildArgs({ ...c, extraArgs: [] }).includes('--provider'), false)
})

test('Config passes PI_* environment through without touching credentials', () => {
  const c = new Config({ env: { PI_OFFLINE: '1' } })
  assert.deepEqual(c.env, { PI_OFFLINE: '1' })
})

test('Config rejects an invalid thinking level at load time', () => {
  assert.throws(() => new Config({ thinking: 'nope' }), /thinking/)
})

test('Config rejects a timeout below the floor', () => {
  assert.throws(() => new Config({ timeoutMs: 5 }), /timeoutMs/)
})

// --- pi.ts: process-level failure handling

import { runPi } from '../dist/pi.js'

test('runPi reports a missing binary with an actionable message', async () => {
  await assert.rejects(
    runPi({
      binary: 'definitely-not-a-real-binary-xyz',
      args: [],
      prompt: 'x',
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
    }),
    /not found.*install/is,
  )
})

test('runPi kills the child and rejects when the caller aborts', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(
    runPi({
      binary: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      prompt: '',
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      signal: controller.signal,
    }),
    /cancelled/i,
  )
})

test('runPi enforces its own timeout', async () => {
  await assert.rejects(
    runPi({
      binary: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      prompt: '',
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 300,
    }),
    /timed out/i,
  )
})

test('runPi deregisters the child so plugin unload has nothing to kill', async () => {
  const track = new Set()
  await assert.rejects(
    runPi({
      binary: process.execPath,
      args: ['-e', 'process.exit(3)'],
      prompt: '',
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      track,
    }),
  )
  assert.equal(track.size, 0)
})
