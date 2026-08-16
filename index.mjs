// Author a lean copy of the `standard` agent preset.
//
// The bundle patch in cordis.patch.yml only reaches rows the profile tree
// mounts at the top level, which is how the headless profile composes its
// tools. The web profile does not work that way: it mounts `agent-presets` and
// the real catalog lives inside a preset composition, which no patch layer can
// reach. So on any profile that has `ctx.agentPresets`, copy `standard` through
// the supported authoring API and disable the same groups in the copy.
//
// Copying rather than shipping our own composition is deliberate. The copy is
// made from whatever `standard` the user actually has, so a dsh upgrade that
// changes `standard` is inherited instead of silently diverging from a fork.
// The preset file itself documents this pattern, "Copy this preset, then remove
// `disabled` from either ordinary tool row".
//
// Nothing here changes the user's default preset. A `default` pointing at a
// preset that failed to author fails loud at mount time, which would brick the
// profile over a convenience. The copy shows up in the preset picker and the
// user chooses it.

import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export const name = 'dsh-lean'

// Only mounts where the preset service exists, which is what keeps this inert
// on headless rather than failing there.
export const inject = ['agentPresets']

const SOURCE_PRESET = 'standard'
const PRESET_ID = 'lean'
const PRESET_NAME = 'Lean'

// Top-level rows in the standard composition. `delegation` is a group holding
// every subagent, workflow and ralph tool, so disabling it removes all of them
// with one edit instead of reaching into nested rows.
const DISABLE = ['delegation', 'tool-goal', 'tool-jobs']

// copy() carries the source's description over, which on `standard` advertises
// goals, subagents and workflows. Those are exactly what the copy removes, so
// leaving it would mislabel the preset in the picker.
const METADATA = `name: ${'Lean'}
description: Coding agent with the delegation, goal and background job tools removed, for a smaller prompt prefix. No subagents, workflows or ralph loop.
`

/**
 * Set `disabled: true` on the named top-level rows of a composition.
 * Returns null when the composition does not have the shape this expects, so
 * the caller degrades with a warning instead of writing a broken preset.
 */
export function disableRows(yaml, ids) {
  const lines = yaml.split('\n')
  const out = []
  const touched = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const id = /^- id:\s*(\S+)\s*$/.exec(lines[i])?.[1]
    if (!id || !ids.includes(id)) continue
    // Look ahead to the end of this row for an existing disabled key.
    let already = false
    for (let j = i + 1; j < lines.length && !/^- /.test(lines[j]); j++) {
      if (/^\s{2}disabled:/.test(lines[j])) already = true
    }
    if (!already) out.push('  disabled: true')
    touched.push(id)
  }
  if (touched.length !== ids.length) return null
  return out.join('\n')
}

export async function apply(ctx) {
  const log = ctx.logger ?? console

  let preset
  try {
    preset = await ctx.agentPresets.resolve(PRESET_ID)
  } catch {
    // Not authored yet. copy() never overwrites, so a race just throws here too.
    try {
      await ctx.agentPresets.copy(SOURCE_PRESET, PRESET_ID, PRESET_NAME)
      preset = await ctx.agentPresets.resolve(PRESET_ID)
    } catch (err) {
      log.warn?.(`dsh-lean: could not author the "${PRESET_ID}" preset (${err?.message}). Nothing was changed.`)
      return
    }
  }

  if (preset.trust !== 'user') {
    log.warn?.(`dsh-lean: "${PRESET_ID}" resolves to a ${preset.trust} preset, refusing to edit it.`)
    return
  }

  let composition
  try {
    composition = await readFile(preset.path, 'utf8')
  } catch (err) {
    log.warn?.(`dsh-lean: could not read ${preset.path} (${err?.message}).`)
    return
  }

  const next = disableRows(composition, DISABLE)
  if (next === null) {
    log.warn?.(
      `dsh-lean: ${preset.path} does not carry the top-level rows this expects ` +
        `(${DISABLE.join(', ')}). The preset was left as a plain copy of ${SOURCE_PRESET}.`,
    )
    return
  }
  if (next === composition) return

  try {
    await writeFile(preset.path, next)
    await writeFile(join(dirname(preset.path), 'preset.yml'), METADATA)
    log.info?.(`dsh-lean: authored the "${PRESET_ID}" preset. Select it to use the trimmed tool set.`)
  } catch (err) {
    log.warn?.(`dsh-lean: could not write ${preset.path} (${err?.message}).`)
  }
}

export default apply
