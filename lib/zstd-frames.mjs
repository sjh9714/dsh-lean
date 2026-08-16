import * as zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// dsh appends to session.jsonl.zstd one frame at a time, and both
// zstdDecompressSync and the stream decoder stop after the first frame, so a
// 136-line session reads back as 1 line. Split on the frame magic and decode
// each piece. A magic sequence can also occur inside compressed bytes, so a
// segment that fails to decode is merged with the next one and retried rather
// than dropped.
export function decodeZstdFrames(buf) {
  // Built-in zstd landed in newer node releases. Callers fall back to the zstd
  // binary when this throws.
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
