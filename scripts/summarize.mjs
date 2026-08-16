#!/usr/bin/env node
// Fold bench/results/*.json into the comparison table the README publishes.
//
// Usage: node scripts/summarize.mjs [--markdown]
//
// Labels follow "<task>-baseline" and "<task>-lean" so runs pair up by task.
// Every number printed here comes from a saved run, so the README can never
// drift from the measurements without this script disagreeing.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const DIR = join(REPO, 'bench/results')

const GROUPS = [
  { task: 'task-00-question', model: 'deepseek-v4-flash', title: 'one question, no edits' },
  { task: 'task-01', model: 'deepseek-v4-flash', title: 'fix three failing tests' },
  { task: 'task-02', model: 'deepseek-v4-flash', title: 'implement a module from sixteen tests' },
  { task: 'task-01', model: 'deepseek-v4-pro', title: 'fix three failing tests, on v4-pro' },
]

function load() {
  if (!existsSync(DIR)) return []
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')))
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

// Classify by the tool count the run actually sent, not by whether a --patch
// argument was present. dsh-lean can arrive either as a --patch overlay or as an
// installed bundle, and only the measured prefix distinguishes the two arms.
const DEFAULT_TOOLS = 25

function arm(runs, task, model, kind) {
  const hit = runs.filter(
    (r) =>
      r.task === task &&
      // Runs recorded before pricing became model-aware carry no model field, and
      // every one of those was on flash.
      (r.model ?? 'deepseek-v4-flash') === model &&
      (kind === 'lean' ? r.prefix.toolCount < DEFAULT_TOOLS : r.prefix.toolCount === DEFAULT_TOOLS),
  )
  return {
    n: hit.length,
    cost: mean(hit.map((r) => r.costUsd)),
    costMin: Math.min(...hit.map((r) => r.costUsd)),
    costMax: Math.max(...hit.map((r) => r.costUsd)),
    miss: mean(hit.map((r) => r.total.inputTokens)),
    prompt: mean(hit.map((r) => r.total.inputTokens + r.total.cacheReadTokens)),
    output: mean(hit.map((r) => r.total.outputTokens)),
    wall: mean(hit.map((r) => r.wallMs / 1000)),
    requests: mean(hit.map((r) => r.requests.length)),
    tools: hit[0]?.prefix?.toolCount ?? NaN,
    allVerified: hit.every((r) => r.verify?.skipped || r.verify?.ok),
    verifiable: hit.some((r) => !r.verify?.skipped),
  }
}

function main() {
  const runs = load()
  const markdown = process.argv.includes('--markdown')
  const rows = []

  for (const g of GROUPS) {
    const b = arm(runs, g.task, g.model, 'baseline')
    const l = arm(runs, g.task, g.model, 'lean')
    if (!b.n || !l.n) continue
    rows.push({ g, b, l, saving: (1 - l.cost / b.cost) * 100 })
  }

  if (markdown) {
    console.log('| task | requests | default cost | dsh-lean cost | saved | same deliverable |')
    console.log('|---|---|---|---|---|---|')
    for (const { g, b, l, saving } of rows) {
      const verdict = b.verifiable ? (b.allVerified && l.allVerified ? 'yes, all tests pass both ways' : 'NO') : 'no suite'
      console.log(
        `| ${g.title} | ${b.requests.toFixed(0)} | $${b.cost.toFixed(6)} | $${l.cost.toFixed(6)} | **${saving.toFixed(0)}%** | ${verdict} |`,
      )
    }
    return
  }

  for (const { g, b, l, saving } of rows) {
    console.log(`${g.task}  ${g.title}  [${g.model}]`)
    console.log(`  runs            baseline n=${b.n}, lean n=${l.n}`)
    console.log(`  tools in prefix ${b.tools} -> ${l.tools}`)
    console.log(`  requests        ${b.requests.toFixed(1)} -> ${l.requests.toFixed(1)}`)
    console.log(`  cache-miss in   ${b.miss.toFixed(0)} -> ${l.miss.toFixed(0)}  (${((1 - l.miss / b.miss) * 100).toFixed(1)}%)`)
    console.log(`  prompt tokens   ${b.prompt.toFixed(0)} -> ${l.prompt.toFixed(0)}  (${((1 - l.prompt / b.prompt) * 100).toFixed(1)}%)`)
    console.log(`  output tokens   ${b.output.toFixed(0)} -> ${l.output.toFixed(0)}`)
    console.log(`  wall clock      ${b.wall.toFixed(1)}s -> ${l.wall.toFixed(1)}s`)
    console.log(`  cost            $${b.cost.toFixed(6)} -> $${l.cost.toFixed(6)}  (${saving.toFixed(1)}%, $${(b.cost - l.cost).toFixed(6)} per session)`)
    const overlap = l.costMax > b.costMin
    console.log(
      `  per-run range   $${b.costMin.toFixed(6)}-${b.costMax.toFixed(6)} vs $${l.costMin.toFixed(6)}-${l.costMax.toFixed(6)}` +
        `  ${overlap ? 'RANGES OVERLAP, the arms are not separated by this data' : 'ranges separate'}`,
    )
    console.log(`  deliverable     ${b.verifiable ? (b.allVerified && l.allVerified ? 'identical, all tests pass in every run' : 'MISMATCH') : 'task ships no suite'}`)
    console.log()
  }

  if (!rows.length) console.log('no paired results yet, run scripts/run-bench.mjs first')
}

main()
