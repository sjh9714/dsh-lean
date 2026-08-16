// USD per 1M tokens, read from https://api-docs.deepseek.com/quick_start/pricing
// on 2026-08-16. The cache-miss to cache-hit ratio is the number that matters
// here, 50x on flash and 120x on pro, because the first request of a session
// pays the whole prompt prefix at the miss rate.
//
// The pricing page notes peak and off-peak billing starting 2026-08-16 UTC, with
// off-peak at half the peak rates. These are the peak rates, so a bill computed
// from them is an upper bound. Halving both sides leaves every percentage in the
// README unchanged, since the ratio between them is what the saving depends on.
export const PRICING = {
  'deepseek-v4-flash': { cacheMissIn: 0.14, cacheHitIn: 0.0028, out: 0.28 },
  'deepseek-v4-pro': { cacheMissIn: 0.435, cacheHitIn: 0.003625, out: 0.87 },
}

export const DEFAULT_MODEL = 'deepseek-v4-flash'

// An unknown model falls back to flash rather than throwing, and callers are
// told so they can label the number as approximate instead of presenting a
// wrong currency figure as measured.
export function priceFor(model) {
  const known = PRICING[model]
  return { price: known ?? PRICING[DEFAULT_MODEL], exact: Boolean(known) }
}

export function costUsd(total, model) {
  const { price, exact } = priceFor(model)
  const usd =
    (total.inputTokens * price.cacheMissIn +
      total.cacheReadTokens * price.cacheHitIn +
      total.outputTokens * price.out) /
    1e6
  return { usd, exact }
}
