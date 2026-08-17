English | [简体中文](./README.zh-CN.md)

# dsh-lean

[![npm](https://img.shields.io/npm/v/dsh-lean)](https://www.npmjs.com/package/dsh-lean)
[![prefix](https://img.shields.io/badge/prompt_prefix-53%25_smaller-brightgreen)](#measured)
[![peak](https://img.shields.io/badge/peak_hours-billed_2x-red)](#the-other-half-of-the-bill-is-sent-before-you-type)
[![cost](https://img.shields.io/badge/session_cost-2--41%25_lower-brightgreen)](#measured)
[![runs](https://img.shields.io/badge/measured_over-32_runs-blue)](#reproduce-it)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**DeepSeek started charging double at peak hours on 2026-08-16, and peak is the working day.**

Peak is 01:00-04:00 and 06:00-10:00 UTC. Off-peak is every other hour at exactly half.

| your clock | peak hours, billed at 2x |
|---|---|
| UTC+8 Beijing, Shanghai, Singapore | 09:00-12:00 and 14:00-18:00 |
| UTC+9 Tokyo, Seoul | 10:00-13:00 and 15:00-19:00 |
| UTC+0 London | 01:00-04:00 and 06:00-10:00 |

If you work Asian hours, nearly every line of code you write is billed at the expensive rate, with a gap at lunch. Moving a long run to the evening halves its bill and changes no configuration. Nothing else in a session is a 2x lever.

See what your own last session actually paid, and what it would have cost off-peak. Nothing is installed and nothing leaves your machine.

```sh
npx dsh-lean audit
```

```
  ran 08:42 to 08:42 UTC
  3 of 3 requests hit peak hours (01-04 and 06-10 UTC), 100% of the tokens
  you paid             $0.000951
  same run off-peak    $0.000476   <- $0.000476 less, a 50% cut
```

## The other half of the bill is sent before you type

**dsh sends 8,246 tokens before it reads your prompt. 3,700 of them are tools your session never calls.**

A cache miss costs 31x a cache hit, and the first request of every session pays the entire tool-schema prefix at the miss rate. On a six-request task, averaged over three runs, paying that prefix once is **46% of the whole bill**.

That token count does not move with pricing. The money does, and DeepSeek repriced at 2026-08-16 16:00 UTC. Under the previous flat card the same runs put that payment at 52% of the bill and the miss-to-hit ratio at 50x. Every figure on this page is given under the card in force now.

The same command shows you that too, ranked by which tool schema is costing you the most.

<img src="assets/audit.svg" alt="npx dsh-lean audit output, showing the per-request cache split, the largest tool schemas in the prefix, and what dsh-lean would remove" width="100%">

dsh-lean is the fix: a preset that turns those tool rows off, cutting the prompt prefix by 53%. What that is worth ranges from 2% to 41% of a session bill, and the low end is real.

Every number below came out of the DeepSeek API's own usage accounting, and the harness that produced them is in this repository.

## Measured

dsh 0.1.0-rc.6, measured 2026-08-16. Thirty two runs, each starting from a clean copy of the task.

The prefix reduction is deterministic. The money is not, so both are reported.

| task | runs per arm | cache-miss tokens | session cost | same deliverable |
|---|---|---|---|---|
| one question, no edits | 3 | 8,600 to 4,912  **-43%** | $0.002106 to $0.001243  **-41%** | no suite to run |
| fix three failing tests | 3 | 11,538 to 8,225  **-29%** | $0.003940 to $0.003048  **-23%** | yes, all 9 tests pass both ways |
| implement a module from sixteen tests | 7 | 10,376 to 7,470  **-28%** | $0.004866 to $0.004787  **-2%** | yes, all 16 tests pass both ways |
| fix three failing tests, on `deepseek-v4-pro` | 3 | 10,949 to 8,507  **-22%** | $0.010993 to $0.008817  **-20%** | yes, all 9 tests pass both ways |

Cache-miss tokens are the measurement. The dollars are that measurement priced, and the price moved on 2026-08-16, so `scripts/summarize.mjs` recomputes money from the committed token counts on every run rather than reading back a figure baked in at run time. It prints both cards.

**Read the third row before the first one.** Cache-miss tokens fall by 22% to 43% on every task, which is the part this patch controls directly. Turning that into money is not reliable. On the implementation task the leaner agent took more steps, 4.4 requests against 5.4, and produced 24% more output, which ate most of the saving. Its per-run cost ranges overlap, $0.003072 to $0.005919 for the default against $0.003626 to $0.006109 for dsh-lean, so on that task a dsh-lean run can cost more than a default run. It is in the table because it is the honest floor, and it is the row that needed seven runs per arm before it settled.

The other three rows have ranges that do separate. `node scripts/summarize.mjs` prints n and the per-run range for every row, so this page cannot quote a mean without its spread.

The deliverable column is the load-bearing one. It is there to show the cheaper run did not simply do less work, and in every paired run the task's own test suite ended green on both sides.

Prefix sent on the first request of a session. These are the numbers `npx dsh-lean audit` prints and every committed run records.

| | tools | system prompt | tool schemas | total |
|---|---|---|---|---|
| default | 25 | 4,100 chars | 26,182 chars | 30,282 chars |
| dsh-lean | 12 | 1,853 chars | 12,452 chars | **14,305 chars** |

## Why this saves money

DeepSeek bills a cache-miss input token at **31x** the cache-hit rate, $0.22 against $0.007 per million for `deepseek-v4-flash`. Read from [the pricing page](https://api-docs.deepseek.com/quick_start/pricing). Those are off-peak rates; peak is 01:00-04:00 and 06:00-10:00 UTC at exactly double, so every percentage on this page holds in either window and only the absolute dollars change.

The first request of every session pays the entire prompt prefix at the miss rate. On the six-request task above that one payment was **46% of the whole bill**, averaged over three runs, and it was the same 8,246 tokens every time. From the second request on, the prefix is a cache hit and costs almost nothing.

So the prefix is not expensive because it is large. It is expensive because it is paid once at 31x. Shrinking it is the one lever that touches the part of the bill that actually hurts.

**The card this was measured under is gone.** Every run above was measured before DeepSeek moved to peak and off-peak billing at 2026-08-16 16:00 UTC, and the tiers did not move together. On `deepseek-v4-pro`, reconciled against a billing console in [deepseek-harness#2064](https://github.com/deepseek-ai/deepseek-harness/discussions/2064), cache hits went from $0.003625 to $0.022 while cache misses went from $0.435 to $0.66, so its miss to hit ratio collapses from 120x to 30x, and flash's from 50x to 31x.

The whole table above is already repriced. What that repricing did to it is worth stating plainly, because it cuts both ways.

- The mechanism survived. Cache reads went from 2.7% of the `v4-pro` bill to 9.2%, and this patch shrinks those too, so the money saved per pro session nearly doubled, $0.001233 to **$0.002176**, while the percentage barely moved, 20.1% to 19.8%.
- The floor got worse. Output is now billed at 3x the cache-miss rate rather than 2x, and output is what dilutes this patch, so the implementation task fell from 7% saved to **2%**. The headline range moved from 7-42% to **2-41%**.

Disabling a tool row also drops the paragraph the system prompt generates to explain that tool, which is why the system prompt shrinks by 55% as well.

## Install

```sh
dsh plugin --profile web add dsh-lean        # web UI, then pick "Lean" in the mode menu
dsh plugin --profile headless add dsh-lean   # one-shot CLI, applies immediately
```

Installing straight from the repository also works, though the npm form above is better because a prebuilt package skips pnpm's `allowBuilds` approval step.

```sh
dsh plugin --profile web add "github:sjh9714/dsh-lean"
```

To remove it, `dsh plugin --profile <name> remove dsh-lean`. On the web profile that leaves the authored preset behind; delete `$DSH_HOME/.agent-presets/lean` to remove it too.

### The two profiles work differently, and that matters

The headless profile mounts its tools as top-level rows, so a bundle patch turns them off directly.

The web profile does not. Its bundle already disables those rows at the top level and then mounts `agent-presets`, with the real catalog living inside the `standard` preset composition. **A patch layer cannot reach inside a preset composition.** So on the web profile this package instead copies `standard` through dsh's own `agentPresets.copy()` authoring API and disables the delegation group, the goal tool and the jobs tool in the copy. The copy is made from whatever `standard` you actually have, so a dsh upgrade is inherited rather than diverging from a vendored fork.

It does not change your default preset. A default pointing at a preset that failed to author fails loud at mount time, which would break the profile over a convenience. "Lean" appears in the mode menu and you pick it.

Measured on the web profile, same prompt and same workspace, one session each.

| | tools | system prompt | tool schemas | prefix |
|---|---|---|---|---|
| Standard mode | 25 | 6,100 chars | 26,336 chars | 32,436 chars |
| Lean | 12 | 3,492 chars | 11,842 chars | **15,334 chars** |

That is a 52.7% cut, the same as the headless figure. The cost table above was measured on headless, where the benchmark harness can drive a task end to end; the web numbers here are the prefix only.

## What it turns off

`tool-workflow`, `tool-subagent`, `tool-subagent-fork`, `tool-subagent-control`, `tool-subagent-list-agents`, `tool-goal`, `tool-jobs`, `tool-ralph`.

What stays is the set a coding session actually uses. `bash`, `read`, `write`, `edit`, `glob`, `grep`, `str_replace_editor`, `todo_write`, `skill`, `read_image`, `web_search`, `exit_plan_mode`.

Only tool rows are disabled. The services behind them stay mounted, so anything that injects them still resolves.

## When not to use this

Do not install it if you use subagents, workflows, the goal system, background jobs, or the ralph loop. Those are exactly what it removes, and the agent will tell you it has no such tool.

Two more honest limits.

- **The saving is diluted by output, not by session length.** It removes a fixed amount, roughly 3,700 cache-miss tokens, from the front of each session, and whatever else the session spends dilutes that. Output is the biggest diluter, billed at 3x the cache-miss rate. The 3-request question saves 41% and the 4-request implementation task saves 2%, so request count is not the variable, output volume is.
- **The percentage does not grow on the expensive model.** `deepseek-v4-pro` costs 3x flash across the board, so it buys 3x the absolute saving and the same percentage. Measured, pro saved 20% against flash's 23% on the same task. Under the old flat card pro had a 120x miss to hit ratio against flash's 50x, which looked like a reason to expect more; it was not, and the new card removes even the appearance by putting both models at about 30x.

## Reproduce it

You need a DeepSeek API key and Node 18 or newer.

```sh
git clone https://github.com/sjh9714/dsh-lean
cd dsh-lean

# keep the benchmark away from your personal dsh config
export DSH_HOME="$PWD/.bench-home"
mkdir -p "$DSH_HOME"
cp ~/.dsh/.credentials.yaml "$DSH_HOME/"

node scripts/run-bench.mjs bench/task-01                             # default
node scripts/run-bench.mjs bench/task-01 --patch cordis.patch.yml    # dsh-lean
node scripts/summarize.mjs

# the v4-pro row, same tasks on the expensive model
node scripts/run-bench.mjs bench/task-01 --patch bench/pro.patch.yml
node scripts/run-bench.mjs bench/task-01 --patch bench/pro.patch.yml --patch cordis.patch.yml
```

Each run copies the task to a fresh workspace, runs it through `dsh --profile headless`, verifies the deliverable with the task's own `npm test`, then reads the token counts back out of the session log. Raw results for every run in the table are committed under `bench/results/`.

`npx dsh-lean audit <workspace>` prints the same breakdown for any dsh session you already ran, and `npx dsh-lean audit --all` picks your most recent session anywhere.

## How the measurement works

dsh writes a `session.jsonl.zstd` per run under `$DSH_HOME/sessions`. Two event types carry everything needed.

- `assistant/chunk` with `chunk.type` of `usage` carries the provider's own `inputTokens`, `cacheReadTokens`, `outputTokens` and `reasoningTokens` for each request.
- `request/header` carries the complete tool schema array and system prompt that were sent, which is how the prefix sizes above were measured without spending an extra API call.

`@deepseek-ai/dsh-llm-deepseek` already separates DeepSeek's `prompt_cache_hit_tokens` from `prompt_cache_miss_tokens` before recording them, so the cache split is the provider's number rather than an estimate.

## License

MIT
