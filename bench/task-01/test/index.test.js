import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, clamp, chunk, totalCents, applyDiscount } from '../src/index.js'

test('slugify collapses runs of whitespace into one hyphen', () => {
  assert.equal(slugify('Hello   Wide  World'), 'hello-wide-world')
})

test('slugify lowercases', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('clamp returns max when the value is above max', () => {
  assert.equal(clamp(12, 0, 10), 10)
})

test('clamp returns min when the value is below min', () => {
  assert.equal(clamp(-3, 0, 10), 0)
})

test('clamp passes through a value inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5)
})

test('chunk splits into fixed size groups', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('chunk returns one group when size exceeds length', () => {
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]])
})

test('totalCents multiplies unit price by quantity', () => {
  assert.equal(totalCents([{ unitCents: 250, quantity: 3 }]), 750)
})

test('applyDiscount takes a fractional percent off', () => {
  assert.equal(applyDiscount(1000, 0.25), 750)
})
