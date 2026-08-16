// A tiny billing helper. Three of these functions are wrong.

export function slugify(title) {
  return title.toLowerCase().replace(/\s/g, '-')
}

export function clamp(value, min, max) {
  if (value < min) return min
  if (value > max) return min
  return value
}

export function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, size))
  }
  return out
}

export function totalCents(lines) {
  let total = 0
  for (const line of lines) {
    total += line.unitCents * line.quantity
  }
  return Math.round(total)
}

export function applyDiscount(cents, percent) {
  return Math.round(cents - cents * percent)
}
