// USD per 1M tokens.
//
// DeepSeek moved to peak and off-peak billing at 2026-08-16 16:00 UTC. Peak is
// 01:00-04:00 and 06:00-10:00 UTC, off-peak is every other hour at half the
// peak rate. Read from https://api-docs.deepseek.com/quick_start/pricing.
//
// Off-peak is the default here because it covers 16 of 24 hours. Since both
// tiers scale by exactly 2x, every percentage this project reports is identical
// under either tier; only the absolute dollars double.
//
// The ratio that drives this project is cache miss over cache hit. It is 31x on
// flash and 30x on pro under the current card, down from 50x and 120x under the
// flat card that ended 2026-08-16 16:00 UTC. LEGACY_FLAT is kept so committed
// runs measured before the change can be repriced against both.
export const PRICING = {
  'deepseek-v4-flash': { cacheMissIn: 0.22, cacheHitIn: 0.007, out: 0.66 },
  'deepseek-v4-pro': { cacheMissIn: 0.66, cacheHitIn: 0.022, out: 1.98 },
}

export const PEAK_MULTIPLIER = 2

// Peak is 01:00-04:00 and 06:00-10:00 UTC. Everything else is off-peak at half
// the peak rate. Sessions routinely straddle a boundary, so this is answered per
// request from that request's own timestamp rather than once for the session.
export const PEAK_WINDOWS_UTC = [
  [1, 4],
  [6, 10],
]

export function isPeakUtc(epochMs) {
  const h = new Date(epochMs).getUTCHours()
  return PEAK_WINDOWS_UTC.some(([from, to]) => h >= from && h < to)
}

export const LEGACY_FLAT = {
  'deepseek-v4-flash': { cacheMissIn: 0.14, cacheHitIn: 0.0028, out: 0.28 },
  'deepseek-v4-pro': { cacheMissIn: 0.435, cacheHitIn: 0.003625, out: 0.87 },
}

export const DEFAULT_MODEL = 'deepseek-v4-flash'

// An unknown model falls back to flash rather than throwing, and callers are
// told so they can label the number as approximate instead of presenting a
// wrong currency figure as measured.
export function priceFor(model, { card = PRICING } = {}) {
  const known = card[model]
  return { price: known ?? card[DEFAULT_MODEL], exact: Boolean(known) }
}

export function costUsd(total, model, opts) {
  const { price, exact } = priceFor(model, opts)
  const usd =
    (total.inputTokens * price.cacheMissIn +
      total.cacheReadTokens * price.cacheHitIn +
      total.outputTokens * price.out) /
    1e6
  return { usd, exact }
}
