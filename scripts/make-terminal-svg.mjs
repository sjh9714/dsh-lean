#!/usr/bin/env node
// Render piped terminal text as a self-contained SVG for the README.
//
//   DSH_HOME=... node bin/dsh-lean.mjs audit --all | node scripts/make-terminal-svg.mjs > assets/audit.svg
//
// Hand-rolled rather than pulled from a dependency because the input is plain
// monospace text with no escape codes, and regenerating the image has to stay a
// one-liner so the picture cannot drift from what the tool actually prints.

import { readFileSync } from 'node:fs'

const FONT = 13
const LINE = 19
const PAD_X = 22
const PAD_Y = 46
const CHAR_W = FONT * 0.6
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Colours are picked per line so the picture reads at a glance. Anything the
// preset would remove is the point of the image, so it gets the accent.
// Literal colours, not CSS variables, and no <style> element. GitHub sanitizes
// SVG it serves through its image proxy, and a stripped stylesheet would leave
// black text on a black rectangle.
const C = { fg: '#c9d1d9', dim: '#6e7681', accent: '#f0883e', good: '#3fb950', link: '#58a6ff' }

function colorFor(line) {
  if (line.includes('dsh-lean removes this')) return C.accent
  if (line.includes('<- billed at 50x')) return C.accent
  if (/estimated saving on this session/.test(line)) return C.good
  if (/^\s{2}(session|model)\s/.test(line)) return C.dim
  if (/^\s+Estimated by scaling|^\s+characters removed/.test(line)) return C.dim
  if (/^\s{4}(dsh plugin|https:)/.test(line)) return C.link
  return C.fg
}

const text = readFileSync(0, 'utf8').replace(/\n+$/, '')
const lines = text.split('\n')
const cols = Math.max(...lines.map((l) => l.length), 60)
const width = Math.ceil(cols * CHAR_W + PAD_X * 2)
const height = lines.length * LINE + PAD_Y + 18

const body = lines
  .map((l, i) => {
    if (!l.trim()) return ''
    return `<text x="${PAD_X}" y="${PAD_Y + i * LINE}" fill="${colorFor(l)}" font-family="${MONO}" font-size="${FONT}" xml:space="preserve">${esc(l)}</text>`
  })
  .filter(Boolean)
  .join('\n  ')

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="npx dsh-lean audit output">
  <rect width="${width}" height="${height}" rx="8" fill="#0f1117"/>
  <circle cx="20" cy="19" r="5" fill="#ff5f56"/>
  <circle cx="38" cy="19" r="5" fill="#ffbd2e"/>
  <circle cx="56" cy="19" r="5" fill="#27c93f"/>
  <text x="76" y="24" fill="${C.dim}" font-family="${MONO}" font-size="12">npx dsh-lean audit</text>
  ${body}
</svg>
`)
