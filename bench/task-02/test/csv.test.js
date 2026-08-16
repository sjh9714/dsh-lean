import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, formatCsv } from '../src/csv.js'

test('parses a header and one row', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [{ a: '1', b: '2' }])
})

test('parses multiple rows', () => {
  assert.deepEqual(parseCsv('a\n1\n2'), [{ a: '1' }, { a: '2' }])
})

test('returns an empty array for a header only', () => {
  assert.deepEqual(parseCsv('a,b'), [])
})

test('returns an empty array for empty input', () => {
  assert.deepEqual(parseCsv(''), [])
})

test('keeps a quoted comma inside one field', () => {
  assert.deepEqual(parseCsv('a,b\n"x,y",2'), [{ a: 'x,y', b: '2' }])
})

test('unescapes a doubled quote inside a quoted field', () => {
  assert.deepEqual(parseCsv('a\n"he said ""hi"""'), [{ a: 'he said "hi"' }])
})

test('keeps a newline inside a quoted field', () => {
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",2'), [{ a: 'line1\nline2', b: '2' }])
})

test('tolerates a trailing newline', () => {
  assert.deepEqual(parseCsv('a\n1\n'), [{ a: '1' }])
})

test('tolerates CRLF line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [{ a: '1', b: '2' }])
})

test('fills missing trailing fields with an empty string', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2'), [{ a: '1', b: '2', c: '' }])
})

test('formats rows back to csv', () => {
  assert.equal(formatCsv([{ a: '1', b: '2' }]), 'a,b\n1,2')
})

test('formats an empty row list as an empty string', () => {
  assert.equal(formatCsv([]), '')
})

test('quotes a field containing a comma', () => {
  assert.equal(formatCsv([{ a: 'x,y' }]), 'a\n"x,y"')
})

test('escapes a quote by doubling it', () => {
  assert.equal(formatCsv([{ a: 'he said "hi"' }]), 'a\n"he said ""hi"""')
})

test('quotes a field containing a newline', () => {
  assert.equal(formatCsv([{ a: 'line1\nline2' }]), 'a\n"line1\nline2"')
})

test('round trips through parse and format', () => {
  const source = 'name,note\nalice,"likes ""x"", and y"\nbob,plain'
  assert.equal(formatCsv(parseCsv(source)), source)
})
