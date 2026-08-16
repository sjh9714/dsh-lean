#!/usr/bin/env node
// Read a dsh session log and report where the input tokens went.
//
// Usage:
//   node scripts/analyze-session.mjs <session-dir-or-workspace-cwd> [--json]
//
// dsh stores one directory per workspace under $DSH_HOME/sessions, named by the
// workspace path with separators replaced by dashes and wrapped in `--`. Each
// run writes session.jsonl.zstd, which carries both the per-request usage
// (assistant/chunk with chunk.type "usage") and the full request header
// (request/header, including the complete tool schema array). That header is
// what makes the tool-schema share measurable without spending an API call.

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

function sessionDirForCwd(cwd) {
  return join(DSH_HOME, 'sessions', `-${resolve(cwd).replaceAll('/', '-')}--`)
}

function newestSessionFile(dir) {
  const runs = readdirSync(dir)
    .map((name) => join(dir, name, 'session.jsonl.zstd'))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (!runs.length) throw new Error(`no session.jsonl.zstd under ${dir}`)
  return runs[0].p
}

function readEvents(file) {
  const text = execFileSync('zstd', ['-dc', file], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 512,
  })
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A run killed mid-write leaves a torn last line. Skip it rather than
      // failing the whole analysis.
    }
  }
  return events
}

// Character counts, not tokens. The billed token split comes from the provider
// (usage below); these shares only say which PART of the prompt is large.
const chars = (v) => JSON.stringify(v ?? '').length

function analyze(file) {
  const events = readEvents(file)

  const headers = []
  const usages = []
  let sessionMeta = null

  for (const ev of events) {
    if (ev.type === 'session') sessionMeta = ev
    if (ev.type === 'request/header' && ev.data?.header) headers.push(ev.data.header)
    if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'usage') {
      usages.push({
        turn: ev.data.turn,
        step: ev.data.step,
        ...ev.data.chunk.usage,
      })
    }
  }

  // The same usage object is emitted on both the streaming chunk and the step
  // fold, so collapse by (turn, step) and keep the last value seen.
  const byStep = new Map()
  for (const u of usages) byStep.set(`${u.turn}/${u.step}`, u)
  const requests = [...byStep.values()]

  const total = requests.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (u.cacheReadTokens ?? 0),
      outputTokens: acc.outputTokens + (u.outputTokens ?? 0),
      reasoningTokens: acc.reasoningTokens + (u.reasoningTokens ?? 0),
    }),
    { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  )

  const first = headers[0]
  const toolBreakdown = (first?.tools ?? [])
    .map((t) => ({ name: t.name, chars: chars(t) }))
    .sort((a, b) => b.chars - a.chars)

  const prefix = first
    ? {
        systemChars: chars(first.system),
        toolCount: (first.tools ?? []).length,
        toolChars: toolBreakdown.reduce((n, t) => n + t.chars, 0),
      }
    : null

  return { file, sessionMeta, requests, total, headers, prefix, toolBreakdown }
}

function pct(part, whole) {
  if (!whole) return '  n/a'
  return `${((part / whole) * 100).toFixed(1)}%`.padStart(6)
}

function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: node scripts/analyze-session.mjs <session-dir|workspace-cwd> [--json]')
    process.exit(2)
  }
  const asJson = process.argv.includes('--json')

  // Accept either a session directory (holds session-* subdirectories) or the
  // workspace path the run happened in, which we map to its session directory.
  const direct = isAbsolute(arg) ? arg : resolve(arg)
  const looksLikeSessionDir =
    existsSync(direct) &&
    readdirSync(direct).some((n) => existsSync(join(direct, n, 'session.jsonl.zstd')))
  const dir = looksLikeSessionDir ? direct : sessionDirForCwd(direct)
  if (!existsSync(dir)) throw new Error(`no session directory at ${dir}`)
  const file = newestSessionFile(dir)
  const r = analyze(file)

  if (asJson) {
    console.log(JSON.stringify({ file: r.file, total: r.total, requests: r.requests, prefix: r.prefix, toolBreakdown: r.toolBreakdown }, null, 2))
    return
  }

  console.log(`session   ${r.file}`)
  if (r.sessionMeta) {
    console.log(`preset    ${r.sessionMeta.agentPreset ?? '(default)'}`)
    console.log(`cwd       ${r.sessionMeta.cwd}`)
  }
  console.log()

  console.log('per request')
  console.log('  turn/step   input   cacheRead    output  reasoning')
  for (const u of r.requests) {
    console.log(
      `  ${String(u.turn).padStart(4)}/${String(u.step).padEnd(3)} ` +
        `${String(u.inputTokens ?? 0).padStart(7)} ${String(u.cacheReadTokens ?? 0).padStart(11)} ` +
        `${String(u.outputTokens ?? 0).padStart(9)} ${String(u.reasoningTokens ?? 0).padStart(10)}`,
    )
  }
  console.log()

  const billedPrompt = r.total.inputTokens + r.total.cacheReadTokens
  console.log('totals')
  console.log(`  requests            ${r.requests.length}`)
  console.log(`  input (cache miss)  ${r.total.inputTokens}`)
  console.log(`  cache read          ${r.total.cacheReadTokens}`)
  console.log(`  prompt total        ${billedPrompt}`)
  console.log(`  cache hit rate      ${pct(r.total.cacheReadTokens, billedPrompt)}`)
  console.log(`  output              ${r.total.outputTokens}`)
  console.log(`  reasoning           ${r.total.reasoningTokens}`)
  console.log()

  if (r.prefix) {
    const headerChars = r.prefix.systemChars + r.prefix.toolChars
    console.log('first request prefix, character shares')
    console.log(`  system prompt       ${r.prefix.systemChars} chars`)
    console.log(`  tool schemas        ${r.prefix.toolChars} chars across ${r.prefix.toolCount} tools  ${pct(r.prefix.toolChars, headerChars)} of prefix`)
    console.log()
    console.log('  largest tool schemas')
    for (const t of r.toolBreakdown.slice(0, 12)) {
      console.log(`    ${String(t.chars).padStart(6)}  ${t.name}`)
    }
  }
}

main()
