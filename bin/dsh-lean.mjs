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
import { execFileSync } from 'node:child_process'
import { decodeZstdFrames } from '../lib/zstd-frames.mjs'
import { costUsd, priceFor, isPeakUtc, PEAK_MULTIPLIER } from '../lib/pricing.mjs'
import { projectKey } from '../lib/project-key.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(DSH_HOME, 'sessions')

// The tool rows dsh-lean turns off, and the tool names they contribute.
const REMOVES = new Set([
  'workflow',
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'create_goal',
  'update_goal',
  'get_goal',
  'job_output',
  'job_kill',
  'job_list',
  'ralph',
])

function readSession(file) {
  const buf = readFileSync(file)
  let text
  try {
    text = decodeZstdFrames(buf)
  } catch (primary) {
    // Node gained built-in zstd in 22.15. Older runtimes fall back to the zstd
    // binary, which is not installed by default on macOS or most Linux distros,
    // so say what to do rather than throwing a spawn stack trace at the reader.
    try {
      text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 1 << 29 })
    } catch {
      console.error('Could not read the session log, which is Zstandard compressed.')
      console.error(`  node ${process.version} could not decode it (${primary.message})`)
      console.error('  and the zstd command line tool is not on PATH.')
      console.error('Fix either one. Upgrade to Node 22.15 or newer, or install zstd.')
      process.exit(1)
    }
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
  const dir = join(SESSIONS, projectKey(cwd))
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
        // Each event carries its own epoch ms, which is what makes the peak and
        // off-peak split answerable per request instead of per session.
        time: ev.time ?? null,
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

// DeepSeek moved to peak and off-peak billing at 2026-08-16 16:00 UTC, and peak
// is exactly double. Peak in UTC is 01-04 and 06-10, which lands on 09-12 and
// 14-18 in UTC+8 and 10-13 and 15-19 in UTC+9, so for most of Asia the peak
// window covers the working day. Nothing else in a session is a 2x lever, so it
// is worth reporting even though this tool cannot change it for you.
function reportPeak(r, offPeakCost) {
  const timed = r.requests.filter((u) => typeof u.time === 'number')
  console.log()
  if (!timed.length) {
    console.log('  This session recorded no per-request timestamps, so the peak and off-peak')
    console.log('  split cannot be shown. Peak is 01-04 and 06-10 UTC at double the rate.')
    return
  }

  const peak = timed.filter((u) => isPeakUtc(u.time))
  const label = (u) => new Date(u.time).toISOString().slice(11, 16)
  const first = label(timed[0])
  const last = label(timed[timed.length - 1])

  console.log(`  ran ${first} to ${last} UTC`)

  if (!peak.length) {
    console.log('  all off-peak, which is the cheaper half of the day. Nothing to move.')
    return
  }

  // Requests are what carry cost, so weight the peak share by each request's own
  // billed tokens rather than by request count.
  const weigh = (list) =>
    list.reduce((a, u) => a + (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0), 0)
  const peakShare = weigh(peak) / weigh(timed) || 0
  const paid = offPeakCost * (1 + peakShare * (PEAK_MULTIPLIER - 1))
  const saved = paid - offPeakCost

  console.log(
    `  ${peak.length} of ${timed.length} requests hit peak hours (01-04 and 06-10 UTC), ` +
      `${(peakShare * 100).toFixed(0)}% of the tokens`,
  )
  console.log(`  you paid             ${usd(paid)}`)
  console.log(`  same run off-peak    ${usd(offPeakCost)}   <- ${usd(saved)} less, a ${((saved / paid) * 100).toFixed(0)}% cut`)
  console.log('  peak is 09-12 and 14-18 in UTC+8, 10-13 and 15-19 in UTC+9. Moving long')
  console.log('  runs outside those hours halves the bill and changes no configuration.')
}

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
  const { usd: cost, exact } = costUsd(
    { inputTokens: r.total.miss, cacheReadTokens: r.total.hit, outputTokens: r.total.out },
    r.model,
  )
  const { price } = priceFor(r.model)
  const ratio = Math.round(price.cacheMissIn / price.cacheHitIn)
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
  console.log(`  cache-miss tokens  ${n(r.total.miss)}   <- billed at ${ratio}x the cache-hit rate`)
  console.log(`  output tokens      ${n(r.total.out)}`)
  console.log(`  cost               ${usd(cost)}${exact ? '' : '   (priced with v4-flash rates, model not in the table)'}`)

  reportPeak(r, cost)

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
  // A first request routinely carries more than the prefix, an AGENTS.md or one
  // pasted file does it, so scaling the raw miss count by a prefix share can
  // claim to remove more tokens than the prefix contains. Cap the base at the
  // prefix's own token estimate. 3.7 chars per token is the ratio measured on
  // this project's own runs, 30,282 prefix chars against 8,246 first-request
  // tokens.
  const prefixTokens = prefixChars / 3.7
  const tokensSaved = Math.round(Math.min(firstMiss, prefixTokens) * share)
  const saved = (tokensSaved * price.cacheMissIn) / 1e6

  console.log(`  dsh-lean would remove ${removable.length} of your ${r.tools.length} tools`)
  console.log(`    ${n(removedChars)} of ${n(prefixChars)} prefix chars  (${(share * 100).toFixed(1)}%)`)
  console.log(
    `    estimated saving on this session   ~${n(tokensSaved)} cache-miss tokens, ` +
      `~${usd(saved)}  (${((saved / cost) * 100).toFixed(0)}% of what it cost)`,
  )
  console.log()
  console.log('  Estimated by scaling your own first-request tokens by the share of prefix')
  console.log('  characters removed. Benchmarked end to end it came out at 2% to 41%.')
  console.log()
  console.log('    dsh plugin --profile headless add dsh-lean')
  console.log('    https://github.com/sjh9714/dsh-lean')
  console.log()
}

main()
