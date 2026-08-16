English | [简体中文](./README.zh-CN.md)

# dsh-lean

[![npm](https://img.shields.io/npm/v/dsh-lean)](https://www.npmjs.com/package/dsh-lean)
[![prefix](https://img.shields.io/badge/prompt_prefix-53%25_smaller-brightgreen)](#measured)
[![cost](https://img.shields.io/badge/session_cost-18--42%25_lower-brightgreen)](#measured)
[![runs](https://img.shields.io/badge/measured_over-20_runs-blue)](#reproduce-it)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```sh
npx dsh-lean audit          # see where your own tokens went, installs nothing
```

<img src="assets/audit.svg" alt="npx dsh-lean audit output, showing the per-request cache split, the largest tool schemas in the prefix, and what dsh-lean would remove" width="100%">

**Same answer, smaller bill.** A DeepSeek Harness preset that removes the tool schemas a single-agent coding session never calls, cutting the prompt prefix by 53% and the cost of a session by 18% to 42%.

Start with the audit. It reads a session log dsh already wrote, shows the cache-hit split of every request, ranks the tool schemas in your own prefix, and tells you what this preset would have saved on that exact session. Nothing is installed and nothing leaves your machine.

Every number below came out of the DeepSeek API's own usage accounting, and the harness that produced them is in this repository.

## Measured

dsh 0.1.0-rc.6, measured 2026-08-16. Twenty six runs, each starting from a clean copy of the task.

| task | requests | default cost | dsh-lean cost | saved | same deliverable |
|---|---|---|---|---|---|
| one question, no edits | 3 | $0.001292 | $0.000755 | **42%** | no suite to run |
| fix three failing tests | 6 | $0.002201 | $0.001671 | **24%** | yes, all 9 tests pass both ways |
| implement a module from sixteen tests | 4 | $0.002622 | $0.002141 | **18%** | yes, all 16 tests pass both ways |
| fix three failing tests, on `deepseek-v4-pro` | 6 | $0.006139 | $0.004906 | **20%** | yes, all 9 tests pass both ways |

The first three rows are `deepseek-v4-flash`. The last is the same task on `deepseek-v4-pro`, where the percentage lands in the same range but the money does not. Pro saves $0.001233 a session against flash's $0.000530, so the same change is worth about 2.3x more to whoever is paying the higher rate.

The savings column is the whole point, so the deliverable column is there to prove the cheaper run did not simply do less work. In every paired run the test suite ended green both ways.

Prefix sent on the first request of a session.

| | tools | system prompt | tool schemas | total |
|---|---|---|---|---|
| default | 25 | 4,100 chars | 27,044 chars | 31,144 chars |
| dsh-lean | 12 | 1,853 chars | 12,875 chars | **14,728 chars** |

## Why this saves money

DeepSeek bills a cache-miss input token at **50x** the cache-hit rate, $0.14 against $0.0028 per million for `deepseek-v4-flash` ([pricing](https://api-docs.deepseek.com/quick_start/pricing), read 2026-08-16).

The first request of every session pays the entire prompt prefix at the miss rate. On the six-request task above it was **52% of the whole bill**, averaged over three runs, and it was the same 8,246 tokens every time. From the second request on, the prefix is a cache hit and costs almost nothing.

So the prefix is not expensive because it is large. It is expensive because it is paid once at 50x. Shrinking it is the one lever that touches the part of the bill that actually hurts.

Disabling a tool row also drops the paragraph the system prompt generates to explain that tool, which is why the system prompt shrinks by 55% as well.

## Install

```sh
dsh plugin --profile headless add dsh-lean
```

Installing straight from the repository also works, though the npm form above is better because a prebuilt package skips pnpm's `allowBuilds` approval step.

```sh
dsh plugin --profile headless add "github:sjh9714/dsh-lean"
```

### It does not change the web profile yet, and here is why

Every number on this page was measured on `--profile headless`. On `--profile web` this patch currently does nothing, and saying otherwise would be wrong.

The web bundle already disables all of these rows at the top level, then mounts `agent-presets` with `default: standard`, and the `standard` preset re-mounts the full catalog inside its own composition. A bundle patch layer composes over the profile tree and never reaches inside a preset composition, so the rows it targets on the web profile are ones that were already off. A real web session on this machine still sent all 25 tools.

Making this work on the web profile needs a preset shipped into `$DSH_HOME/.agent-presets` rather than a patch, which is the next thing to build. Until then, install it on `headless` where it is measured to work.

To remove it.

```sh
dsh plugin --profile headless remove dsh-lean
```

## What it turns off

`tool-workflow`, `tool-subagent`, `tool-subagent-fork`, `tool-subagent-control`, `tool-subagent-list-agents`, `tool-goal`, `tool-jobs`, `tool-ralph`.

What stays is the set a coding session actually uses. `bash`, `read`, `write`, `edit`, `glob`, `grep`, `str_replace_editor`, `todo_write`, `skill`, `read_image`, `web_search`, `exit_plan_mode`.

Only tool rows are disabled. The services behind them stay mounted, so anything that injects them still resolves.

## When not to use this

Do not install it if you use subagents, workflows, the goal system, background jobs, or the ralph loop. Those are exactly what it removes, and the agent will tell you it has no such tool.

Two more honest limits.

- **The saving shrinks as the session grows.** It removes a fixed amount, roughly 3,700 cache-miss tokens, from the front of each session. On a one-shot question that is 42% of the bill. On a long session it is a small share. Nothing here makes a two-hour session 42% cheaper.
- **The percentage does not grow on the expensive model.** `deepseek-v4-pro` bills a cache miss at 120x a cache hit against flash's 50x, so the prefix looks like a bigger target, but pro also bills output at twice its miss rate. Output grows as a share of the bill and cancels most of the gain. Measured, pro saved 20% against flash's 24% on the same task. The absolute money saved is what changes, not the percentage.

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

# the v4-pro row, same tasks priced against a 120x cache ratio
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
