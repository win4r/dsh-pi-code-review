# [🚀观看我的哔哩哔哩视频](https://space.bilibili.com/3493277319825652)

# dsh-pi-review

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) plugin that delegates
code review to the [Pi coding agent](https://github.com/earendil-works/pi).

It registers one tool, `pi_code_review`. The harness agent calls it, the plugin collects the right
git diff, runs `pi` headlessly as a subprocess, and returns **structured findings** — severity,
category, file, line, and a suggested fix — that the harness renders as Markdown.

Using a second, independent agent for review is the point: Pi runs with its own model and its own
context, so it is not reviewing its own work.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # provides `pi`

cd dsh-pi-review && npm install && npm run build
dsh plugin --profile <your-profile> add ./dsh-pi-review
```

**Authentication is Pi's job, not this plugin's.** The plugin never reads, passes, or validates a
credential. It invokes `pi` and lets it resolve its own auth — Codex Auth, an OAuth session, or
whatever the provider uses. Leave `provider` and `model` unset and Pi applies its own configured
defaults (`~/.pi/agent/settings.json`).

`dsh plugin add` merges `cordis.patch.yml` into the profile's `cordis.yml`. Every config key is
optional; defaults come from the Schemastery schema in `src/config.ts`.

## Usage

Just ask the harness agent — it picks the tool up from the description:

> review my staged changes
> review this branch against origin/main, focus on error handling
> give me a second opinion on src/auth.ts

Example output:

```
## Pi code review — ⛔ Request changes

The change removes the empty-input guard from `averageScore`, which makes empty arrays
produce `NaN` instead of a usable default. It also adds a new database helper that
concatenates untrusted input directly into SQL, creating a straightforward injection sink.

**Scope:** all uncommitted changes (git diff HEAD) · **Files:** 2 · **Findings:** 2 (1 high, 1 low)

### 🔴 Use a parameterized query instead of string concatenation
`users.js:2` · high · security · confidence: high
...
_Reviewed by Pi (gpt-5.4-mini) in 15.0s · $0.0041._
```

### Tool parameters

| Parameter | Description |
|---|---|
| `scope` | `uncommitted` (default, `git diff HEAD`), `staged`, `unstaged`, `branch`, `commit`, `files` |
| `baseRef` | Base for `scope: branch`; resolved through `git merge-base`, so you see only your own commits |
| `headRef` | Head for `branch`, or the commit for `scope: commit`. Defaults to `HEAD` |
| `paths` | Repo-relative paths. Required for `scope: files`; elsewhere narrows the diff |
| `focus` | Extra emphasis for one run, e.g. `"concurrency and error handling"` |
| `severityFloor` | Lowest severity worth reporting. Defaults to `low` |
| `model` | Override the configured Pi model for one run |
| `cwd` | Directory to run in. Defaults to the harness working directory |

### Configuration

Set in `cordis.yml` under the plugin entry. Notable keys:

| Key | Default | Notes |
|---|---|---|
| `binary` | `pi` | Use an absolute path if the harness PATH differs from your shell's |
| `provider` / `model` | *(unset)* | Leave unset to inherit Pi's configured default, which carries its auth |
| `thinking` | `high` | Review quality is genuinely sensitive to this |
| `readOnly` | `true` | Restricts Pi to `read,grep,find,ls` |
| `contextFiles` | `true` | Lets Pi read `AGENTS.md` / `CLAUDE.md` so reviews respect project conventions |
| `timeoutMs` | `600000` | Hard wall-clock limit |
| `maxDiffBytes` | `240000` | Whole files past the budget are dropped **and reported**, never silently cut |
| `defaultBaseRef` | `origin/main` | Used by `scope: branch` |
| `includeUntracked` | `true` | Synthesises diffs for new files that `git diff` cannot see |
| `guidelines` | `""` | Standing review instructions prepended to every request |
| `env` | `{}` | Extra `PI_*` environment for the Pi process, e.g. `PI_OFFLINE`. Not for credentials |

## Design notes

Four things here are load-bearing, each driven by behaviour verified against the real `pi` binary
(v0.84.2) rather than assumed from its docs:

**`pi` exits 0 even when the model call fails.** A 401 from the provider still produces exit code 0.
Trusting the exit code would report an auth failure as a clean review. The plugin therefore treats
`--mode json` event stream as the source of truth and fails on any assistant message with
`stopReason: "error"`.

**Untracked files are invisible to `git diff`.** A review of "what I changed" would silently skip
every brand-new file — the most review-worthy code in the change. The plugin enumerates untracked
files and synthesises diffs against `/dev/null`. The end-to-end test asserts this specifically.

**The reviewer is read-only by default.** Pi ships no permission sandbox and runs with the
launching user's full privileges. A reviewer has no business writing to the workspace, so
`readOnly` restricts it to `read,grep,find,ls`.

**Truncation is always reported.** When a diff exceeds `maxDiffBytes` the plugin drops whole files
and names them, both to the model in the prompt (as "do NOT comment on these") and to the user in
the rendered output. Silent truncation would read as "everything was reviewed."

Beyond that, `normaliseReport` coerces near-miss model output rather than rejecting it — synonym
severities (`blocker` → `critical`), alternate field names (`issues`/`path`/`message`), and a
missing verdict all get repaired. If no JSON can be found at all, Pi's raw answer is surfaced
instead of a misleading "no findings".

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: `name`, `inject`, `Config`, `apply`; tool schema and orchestration |
| `src/config.ts` | Schemastery config schema |
| `src/git.ts` | Diff collection, untracked-file handling, size budgeting |
| `src/pi.ts` | Pi subprocess: argv construction, JSON event-stream parsing, timeout/abort |
| `src/prompt.ts` | Review prompt and JSON extraction from a free-form answer |
| `src/report.ts` | Normalisation of model output and Markdown rendering |
| `src/types.ts` | Shared types. Written as `type` aliases so `stats` satisfies the harness `JsonValue` node |

## Tests

```bash
npm test                  # unit tests, no network, no API cost
node test/integration.mjs # real `pi`, real provider, costs ~$0.005
```

The integration test builds a throwaway repo containing two planted bugs — a removed
divide-by-zero guard in a tracked file and a SQL injection in an *untracked* file — and fails if
the review misses either.

Both suites pass as of this writing; the unit suite caught a real defect during development
(a promise in the subprocess abort path that never settled).

## Extending

`apply()` is a normal Cordis plugin, so the usual seams are available:

- **Gate other tools on a clean review** — `ctx.on('tools/pre-execute', ...)` can deny a commit tool
  when the last review returned `request-changes`.
- **Review on every turn** — observe `session/event` and call the tool when a turn edits files.
- **Swap the backend** — `src/pi.ts` is the only module that knows about Pi. Anything that accepts a
  prompt on stdin and emits JSON lines drops in behind the same interface.

Subprocesses are registered in a `Set` cleaned up by `ctx.effect()`, so a plugin unload or HMR
reload kills in-flight reviews instead of orphaning a paid provider session.
