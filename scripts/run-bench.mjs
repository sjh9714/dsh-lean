#!/usr/bin/env node
// Run one bench task through dsh headless and report what it cost.
//
// Usage:
//   node scripts/run-bench.mjs <task-dir> [--patch <file>]... [--label <name>]
//
// Each run copies the task to a fresh workspace so repeated runs start from the
// same state, boots `dsh --profile headless` there, then verifies the
// deliverable with the task's own `npm test` and reads the token usage back out
// of the session log. Results land in bench/results/<label>-<timestamp>.json.

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync, readFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { costUsd } from '../lib/pricing.mjs'
import { decodeZstdFrames } from '../lib/zstd-frames.mjs'

const REPO = resolve(import.meta.dirname, '..')

function parseArgs(argv) {
  const patches = []
  let task = null
  let label = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--patch') patches.push(resolve(argv[++i]))
    else if (argv[i] === '--label') label = argv[++i]
    else if (!task) task = resolve(argv[i])
  }
  if (!task) {
    console.error('usage: node scripts/run-bench.mjs <task-dir> [--patch <file>]... [--label <name>]')
    process.exit(2)
  }
  return { task, patches, label: label ?? 'default' }
}

function freshWorkspace(taskDir, label) {
  // A distinct directory per run keeps dsh session logs separate, since dsh
  // keys its session directory by workspace path.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const ws = join(tmpdir(), `dsh-bench-${basename(taskDir)}-${label}-${stamp}`)
  cpSync(taskDir, ws, { recursive: true })
  // macOS hands out /var/folders/... while dsh keys its session directory by the
  // resolved path, so realpath here or the session log cannot be found later.
  return realpathSync(ws)
}

function sessionDirForCwd(dshHome, cwd) {
  return join(dshHome, 'sessions', `-${resolve(cwd).replaceAll('/', '-')}--`)
}

function newestSessionFile(dir) {
  const runs = readdirSync(dir)
    .map((n) => join(dir, n, 'session.jsonl.zstd'))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (!runs.length) throw new Error(`no session log under ${dir}`)
  return runs[0].p
}

function readUsage(sessionFile) {
  let text
  try {
    text = decodeZstdFrames(readFileSync(sessionFile))
  } catch {
    // Older node without built-in zstd falls back to the CLI tool.
    text = execFileSync('zstd', ['-dc', sessionFile], { encoding: 'utf8', maxBuffer: 1 << 29 })
  }
  const byStep = new Map()
  let firstHeader = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'request/header' && !firstHeader) firstHeader = ev.data?.header
    if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'usage') {
      byStep.set(`${ev.data.turn}/${ev.data.step}`, { turn: ev.data.turn, step: ev.data.step, ...ev.data.chunk.usage })
    }
  }
  const requests = [...byStep.values()]
  const total = requests.reduce(
    (a, u) => ({
      inputTokens: a.inputTokens + (u.inputTokens ?? 0),
      cacheReadTokens: a.cacheReadTokens + (u.cacheReadTokens ?? 0),
      outputTokens: a.outputTokens + (u.outputTokens ?? 0),
      reasoningTokens: a.reasoningTokens + (u.reasoningTokens ?? 0),
    }),
    { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  )
  const toolChars = (firstHeader?.tools ?? []).reduce((n, t) => n + JSON.stringify(t).length, 0)
  return {
    requests,
    total,
    model: firstHeader?.config?.model ?? null,
    prefix: {
      toolCount: (firstHeader?.tools ?? []).length,
      toolChars,
      systemChars: JSON.stringify(firstHeader?.system ?? '').length,
    },
  }
}


function main() {
  const { task, patches, label } = parseArgs(process.argv.slice(2))
  const dshHome = process.env.DSH_HOME
  if (!dshHome) {
    console.error('DSH_HOME must be set so the benchmark does not read your personal dsh config')
    process.exit(2)
  }

  const prompt = execFileSync('cat', [join(task, 'PROMPT.txt')], { encoding: 'utf8' }).trim()
  const ws = freshWorkspace(task, label)
  console.log(`workspace  ${ws}`)
  console.log(`label      ${label}`)
  console.log(`patches    ${patches.length ? patches.join(', ') : '(none)'}`)

  const args = ['--yes', '@deepseek-ai/dsh', '--profile', 'headless']
  for (const p of patches) args.push('--patch', p)
  args.push(prompt)

  const started = Date.now()
  const run = spawnSync('npx', args, { cwd: ws, encoding: 'utf8', env: process.env })
  const wallMs = Date.now() - started

  if (run.status !== 0) {
    console.log()
    console.log(`dsh exited ${run.status}. stderr tail:`)
    console.log((run.stderr ?? '').split('\n').slice(-15).join('\n'))
  }

  // Tasks that ship a test suite prove the cheaper run still delivered the same
  // thing. Tasks without one (a plain question) have nothing to verify.
  const verifiable = existsSync(join(ws, 'package.json'))
  let pass = -1
  let fail = -1
  if (verifiable) {
    const verify = spawnSync('npm', ['test'], { cwd: ws, encoding: 'utf8' })
    const testOut = `${verify.stdout ?? ''}${verify.stderr ?? ''}`
    pass = Number(/^# pass (\d+)$/m.exec(testOut)?.[1] ?? -1)
    fail = Number(/^# fail (\d+)$/m.exec(testOut)?.[1] ?? -1)
  }

  const usage = readUsage(newestSessionFile(sessionDirForCwd(dshHome, ws)))
  const { usd: cost, exact: pricedExactly } = costUsd(usage.total, usage.model)
  const billedPrompt = usage.total.inputTokens + usage.total.cacheReadTokens

  const result = {
    label,
    task: basename(task),
    workspace: ws,
    patches,
    wallMs,
    dshExitCode: run.status,
    verify: verifiable ? { pass, fail, ok: fail === 0 && pass > 0 } : { skipped: true },
    ...usage,
    model: usage.model,
    pricedExactly,
    costUsd: cost,
  }

  mkdirSync(join(REPO, 'bench/results'), { recursive: true })
  const out = join(REPO, 'bench/results', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(out, JSON.stringify(result, null, 2))

  console.log()
  console.log(`requests          ${usage.requests.length}`)
  console.log(`input, miss       ${usage.total.inputTokens}`)
  console.log(`input, cache hit  ${usage.total.cacheReadTokens}`)
  console.log(`prompt total      ${billedPrompt}`)
  console.log(`cache hit rate    ${billedPrompt ? ((usage.total.cacheReadTokens / billedPrompt) * 100).toFixed(1) : 'n/a'}%`)
  console.log(`output            ${usage.total.outputTokens}`)
  console.log(`tools in prefix   ${usage.prefix.toolCount} tools, ${usage.prefix.toolChars} chars`)
  console.log(`wall clock        ${(wallMs / 1000).toFixed(1)}s`)
  console.log(`model             ${usage.model ?? 'unknown'}${pricedExactly ? '' : '  (priced with v4-flash rates)'}`)
  console.log(`cost              $${cost.toFixed(6)}`)
  console.log(
    verifiable
      ? `tests             ${pass} pass / ${fail} fail  ${result.verify.ok ? 'DELIVERABLE OK' : 'DELIVERABLE FAILED'}`
      : 'tests             (task ships no suite, nothing to verify)',
  )
  console.log(`saved             ${out}`)

  if (run.status !== 0) {
    console.log()
    console.log('dsh stderr tail:')
    console.log((run.stderr ?? '').split('\n').slice(-12).join('\n'))
  }
}

main()
