import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')

// The patch is a flat list of `- id: <row>` / `disabled: true` pairs, so a regex
// reads it without pulling in a YAML dependency for six lines of grammar.
function disabledIds(yamlText) {
  const ids = []
  const lines = yamlText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const id = /^- id:\s*(\S+)/.exec(lines[i])?.[1]
    if (!id) continue
    if (/^\s+disabled:\s*true\s*$/.test(lines[i + 1] ?? '')) ids.push(id)
  }
  return ids
}

const EXPECTED = [
  'tool-workflow',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-goal',
  'tool-jobs',
  'tool-ralph',
]

test('the patch disables exactly the documented tool rows', () => {
  const ids = disabledIds(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(ids.sort(), [...EXPECTED].sort())
})

// The real failure mode is silent: if dsh renames or removes one of these rows,
// the patch keeps parsing and simply stops saving anything. This check turns
// that into a visible failure whenever a dsh install is reachable.
function findBasePatch() {
  const candidates = []
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) {
    for (const dir of readdirSync(npx)) {
      candidates.push(join(npx, dir, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'))
    }
  }
  candidates.push(join(ROOT, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'))
  return candidates.find((p) => existsSync(p))
}

test('every disabled row still exists in the installed dsh-base bundle', (t) => {
  const basePatch = findBasePatch()
  if (!basePatch) {
    t.skip('no @deepseek-ai/dsh-base install found to check against')
    return
  }
  const base = readFileSync(basePatch, 'utf8')
  const missing = EXPECTED.filter((id) => !new RegExp(`^\\s*- id:\\s*${id}\\s*$`, 'm').test(base))
  assert.deepEqual(missing, [], `rows no longer present in dsh-base: ${missing.join(', ')}`)
})

// dsh appends to session.jsonl.zstd one frame at a time, and node's
// zstdDecompressSync stops after the first frame. The audit CLI splits on the
// frame magic to read all of them, so this guards the case that broke.
test('the audit decoder reads every frame of a multi-frame zstd file', async () => {
  const { zstdCompressSync } = await import('node:zlib')
  const { decodeZstdFrames } = await import('../lib/zstd-frames.mjs')
  const parts = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']
  const multi = Buffer.concat(parts.map((p) => zstdCompressSync(Buffer.from(p))))
  assert.equal(decodeZstdFrames(multi), parts.join(''))
})

// The web bundle already disables these rows at the top level and then mounts
// the real catalog inside the `standard` agent preset, which a bundle patch
// cannot reach. This test pins that fact so the README can never quietly go
// back to claiming the patch does something on `--profile web`.
test('the web bundle already disables these rows, so the patch is inert there', (t) => {
  const npx = join(homedir(), '.npm/_npx')
  let webPatch = null
  if (existsSync(npx)) {
    for (const dir of readdirSync(npx)) {
      const p = join(npx, dir, 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')
      if (existsSync(p)) webPatch = p
    }
  }
  if (!webPatch) {
    t.skip('no @deepseek-ai/dsh-web-app install found to check against')
    return
  }
  const web = readFileSync(webPatch, 'utf8')
  const stillLive = EXPECTED.filter((id) => {
    const at = web.indexOf(`- id: ${id}\n`)
    if (at === -1) return false
    const next = web.indexOf('\n- id:', at + 1)
    return !web.slice(at, next === -1 ? undefined : next).includes('disabled: true')
  })
  assert.deepEqual(
    stillLive,
    [],
    `these rows are NOT already disabled in dsh-web-app, so disabling them there is a real change and the README claim would need revisiting: ${stillLive.join(', ')}`,
  )
})
