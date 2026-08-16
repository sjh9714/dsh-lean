#!/usr/bin/env node
// dsh-lean audit — read one of your own dsh sessions and show where the bill went.
//
//   npx dsh-lean audit            # newest session for the current directory
//   npx dsh-lean audit <path>     # newest session for that workspace
//   npx dsh-lean audit --all      # newest session across every workspace
//
// Nothing is installed and nothing is sent anywhere. It reads the session log
// dsh already wrote under $DSH_HOME/sessions.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import * as zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(DSH_HOME, 'sessions')

// deepseek-v4-flash, USD per 1M tokens, from
// https://api-docs.deepseek.com/quick_start/pricing read 2026-08-16.
const PRICE = { miss: 0.14, hit: 0.0028, out: 0.28 }

// The tool rows dsh-lean turns off, and the tool names they contribute.
const REMOVES = new Set([
  'workflow',
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'subagent_report',
  'create_goal',
  'update_goal',
  'get_goal',
  'job_output',
  'job_kill',
  'job_list',
  'ralph',
])

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// dsh appends to session.jsonl.zstd one frame at a time, and both
// zstdDecompressSync and the stream decoder stop after the first frame. Split on
// the frame magic and decode each piece. A magic sequence can also occur inside
// compressed bytes, so a segment that fails to decode is merged with the next
// one and retried rather than dropped.
export function decodeZstdFrames(buf) {
  // Built-in zstd landed in newer node releases. Older ones fall back to the
  // zstd binary in readSession rather than failing here.
  const { zstdDecompressSync } = zlib
  if (typeof zstdDecompressSync !== 'function') throw new Error('node build has no zstd support')

  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (!starts.length) throw new Error('not a zstd file')

  const out = []
  let from = 0
  while (from < starts.length) {
    let to = from + 1
    let decoded = null
    while (to <= starts.length) {
      const end = to < starts.length ? starts[to] : buf.length
      try {
        decoded = zstdDecompressSync(buf.subarray(starts[from], end))
        break
      } catch {
        to++
      }
    }
    if (!decoded) throw new Error('could not decode zstd frame')
    out.push(decoded)
    from = to
  }
  return Buffer.concat(out).toString('utf8')
}

function readSession(file) {
  const buf = readFileSync(file)
  let text
  try {
    text = decodeZstdFrames(buf)
  } catch {
    // Last resort, the zstd binary handles concatenated frames natively.
    text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 1 << 29 })
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A run killed mid-write leaves one torn line.
    }
  }
  return events
}

function newestSession(dir) {
  if (!existsSync(dir)) return null
  const runs = readdirSync(dir)
    .map((n) => join(dir, n, 'session.jsonl.zstd'))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return runs[0]?.p ?? null
}

function pickSession(arg) {
  if (!existsSync(SESSIONS)) {
    console.error(`No dsh sessions found under ${SESSIONS}`)
    console.error('Run dsh at least once, or set DSH_HOME if your install uses another location.')
    process.exit(1)
  }
  if (arg === '--all') {
    const all = readdirSync(SESSIONS)
      .map((n) => newestSession(join(SESSIONS, n)))
      .filter(Boolean)
      .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (!all.length) {
      console.error('No session logs found.')
      process.exit(1)
    }
    return all[0].p
  }
  const cwd = resolve(arg ?? process.cwd())
  const dir = join(SESSIONS, `-${cwd.replaceAll('/', '-')}--`)
  const found = newestSession(dir)
  if (found) return found
  console.error(`No dsh session recorded for ${cwd}`)
  console.error('Try `npx dsh-lean audit --all` to audit your most recent session anywhere.')
  process.exit(1)
}

function analyze(events) {
  const byStep = new Map()
  let header = null
  let model = null
  for (const ev of events) {
    if (ev.type === 'request/header' && !header) {
      header = ev.data?.header
      model = header?.config?.model ?? null
    }
    if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'usage') {
      byStep.set(`${ev.data.turn}/${ev.data.step}`, {
        turn: ev.data.turn,
        step: ev.data.step,
        ...ev.data.chunk.usage,
      })
    }
  }
  const requests = [...byStep.values()]
  const total = requests.reduce(
    (a, u) => ({
      miss: a.miss + (u.inputTokens ?? 0),
      hit: a.hit + (u.cacheReadTokens ?? 0),
      out: a.out + (u.outputTokens ?? 0),
    }),
    { miss: 0, hit: 0, out: 0 },
  )
  const tools = (header?.tools ?? []).map((t) => ({ name: t.name, chars: JSON.stringify(t).length }))
  tools.sort((a, b) => b.chars - a.chars)
  const systemChars = (header?.system ?? '').length
  const toolChars = tools.reduce((n, t) => n + t.chars, 0)
  return { requests, total, tools, systemChars, toolChars, model }
}

const n = (x) => x.toLocaleString('en-US')
const usd = (x) => `$${x.toFixed(6)}`

function main() {
  const args = process.argv.slice(2).filter((a) => a !== 'audit')
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: npx dsh-lean audit [workspace-path | --all]')
    process.exit(0)
  }

  const file = pickSession(args[0])
  const r = analyze(readSession(file))

  if (!r.requests.length) {
    console.error(`No model requests recorded in ${file}`)
    process.exit(1)
  }

  const prompt = r.total.miss + r.total.hit
  const cost = (r.total.miss * PRICE.miss + r.total.hit * PRICE.hit + r.total.out * PRICE.out) / 1e6
  const prefixChars = r.systemChars + r.toolChars

  console.log()
  console.log(`  session   ${basename(join(file, '..'))}`)
  console.log(`  model     ${r.model ?? 'unknown'}`)
  console.log()
  console.log('  request    input (miss)    cache hit      output')
  for (const u of r.requests) {
    console.log(
      `  ${`${u.turn}/${u.step}`.padEnd(9)}${String(n(u.inputTokens ?? 0)).padStart(12)}` +
        `${String(n(u.cacheReadTokens ?? 0)).padStart(13)}${String(n(u.outputTokens ?? 0)).padStart(12)}`,
    )
  }
  console.log()
  console.log(`  requests           ${r.requests.length}`)
  console.log(`  prompt tokens      ${n(prompt)}`)
  console.log(`  cache hit rate     ${((r.total.hit / prompt) * 100).toFixed(1)}%`)
  console.log(`  cache-miss tokens  ${n(r.total.miss)}   <- billed at 50x the cache-hit rate`)
  console.log(`  output tokens      ${n(r.total.out)}`)
  console.log(`  cost               ${usd(cost)}`)

  if (!prefixChars) {
    console.log()
    console.log('  This session logged no request header, so the prefix cannot be measured.')
    return
  }

  console.log()
  console.log(`  first request prefix   ${n(prefixChars)} chars`)
  console.log(`    system prompt        ${n(r.systemChars)} chars`)
  console.log(`    tool schemas         ${n(r.toolChars)} chars across ${r.tools.length} tools`)
  console.log()
  console.log('  largest tool schemas')
  for (const t of r.tools.slice(0, 10)) {
    const mark = REMOVES.has(t.name) ? '  <- dsh-lean removes this' : ''
    console.log(`    ${String(n(t.chars)).padStart(7)}  ${t.name}${mark}`)
  }

  const removable = r.tools.filter((t) => REMOVES.has(t.name))
  const removedChars = removable.reduce((a, t) => a + t.chars, 0)

  console.log()
  if (!removable.length) {
    console.log('  dsh-lean would remove nothing here. This profile already has none of the')
    console.log('  tools it targets, so there is nothing for it to save.')
    return
  }

  // The first request pays the whole prefix at the cache-miss rate, so scale that
  // request's measured tokens by the share of prefix characters that would go.
  // This is an estimate from your own numbers, not a second measurement.
  const firstMiss = r.requests[0].inputTokens ?? 0
  const share = removedChars / prefixChars
  const tokensSaved = Math.round(firstMiss * share)
  const saved = (tokensSaved * PRICE.miss) / 1e6

  console.log(`  dsh-lean would remove ${removable.length} of your ${r.tools.length} tools`)
  console.log(`    ${n(removedChars)} of ${n(prefixChars)} prefix chars  (${(share * 100).toFixed(1)}%)`)
  console.log(
    `    estimated saving on this session   ~${n(tokensSaved)} cache-miss tokens, ` +
      `~${usd(saved)}  (${((saved / cost) * 100).toFixed(0)}% of what it cost)`,
  )
  console.log()
  console.log('  Estimated by scaling your own first-request tokens by the share of prefix')
  console.log('  characters removed. Benchmarked end to end it came out at 18% to 42%.')
  console.log()
  console.log('    dsh plugin --profile web add dsh-lean')
  console.log('    https://github.com/sjh9714/dsh-lean')
  console.log()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
