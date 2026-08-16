English | [简体中文](./README.zh-CN.md)

# dsh-lean

[![npm](https://img.shields.io/npm/v/dsh-lean)](https://www.npmjs.com/package/dsh-lean)
[![prefix](https://img.shields.io/badge/prompt_prefix-53%25_smaller-brightgreen)](#measured)
[![cost](https://img.shields.io/badge/session_cost-18--42%25_lower-brightgreen)](#measured)
[![runs](https://img.shields.io/badge/measured_over-20_runs-blue)](#reproduce-it)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```sh
dsh plugin --profile web add dsh-lean
```

**Same answer, smaller bill.** A DeepSeek Harness preset that removes the tool schemas a single-agent coding session never calls, cutting the prompt prefix by 53% and the cost of a session by 18% to 42%.

Every number below came out of the DeepSeek API's own usage accounting, and the harness that produced them is in this repository.

## Measured

dsh 0.1.0-rc.6, `deepseek-v4-flash`, measured 2026-08-16. Twenty runs, each starting from a clean copy of the task.

| task | requests | default cost | dsh-lean cost | saved | same deliverable |
|---|---|---|---|---|---|
| one question, no edits | 3 | $0.001292 | $0.000755 | **42%** | no suite to run |
| fix three failing tests | 6 | $0.002201 | $0.001671 | **24%** | yes, all 9 tests pass both ways |
| implement a module from sixteen tests | 4 | $0.002622 | $0.002141 | **18%** | yes, all 16 tests pass both ways |

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
dsh plugin --profile web add dsh-lean
```

Replace `web` with whichever profile you use. That is the whole installation, there is no config file to edit.

To remove it.

```sh
dsh plugin --profile web remove dsh-lean
```

## What it turns off

`tool-workflow`, `tool-subagent`, `tool-subagent-fork`, `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent-report`, `tool-goal`, `tool-jobs`, `tool-ralph`.

What stays is the set a coding session actually uses. `bash`, `read`, `write`, `edit`, `glob`, `grep`, `str_replace_editor`, `todo_write`, `skill`, `read_image`, `web_search`, `exit_plan_mode`.

Only tool rows are disabled. The services behind them stay mounted, so anything that injects them still resolves.

## When not to use this

Do not install it if you use subagents, workflows, the goal system, background jobs, or the ralph loop. Those are exactly what it removes, and the agent will tell you it has no such tool.

Two more honest limits.

- **The saving shrinks as the session grows.** It removes a fixed amount, roughly 3,700 cache-miss tokens, from the front of each session. On a one-shot question that is 42% of the bill. On a long session it is a small share. Nothing here makes a two-hour session 42% cheaper.
- **It was measured on `deepseek-v4-flash`.** The mechanism is provider-independent, but the percentages depend on the cache-hit to cache-miss price ratio, which differs per model.

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
```

Each run copies the task to a fresh workspace, runs it through `dsh --profile headless`, verifies the deliverable with the task's own `npm test`, then reads the token counts back out of the session log. Raw results for every run in the table are committed under `bench/results/`.

`scripts/analyze-session.mjs <workspace>` prints the same breakdown for any dsh session you already ran, including the per-request cache hit split and the largest tool schemas in your own prefix.

## How the measurement works

dsh writes a `session.jsonl.zstd` per run under `$DSH_HOME/sessions`. Two event types carry everything needed.

- `assistant/chunk` with `chunk.type` of `usage` carries the provider's own `inputTokens`, `cacheReadTokens`, `outputTokens` and `reasoningTokens` for each request.
- `request/header` carries the complete tool schema array and system prompt that were sent, which is how the prefix sizes above were measured without spending an extra API call.

`@deepseek-ai/dsh-llm-deepseek` already separates DeepSeek's `prompt_cache_hit_tokens` from `prompt_cache_miss_tokens` before recording them, so the cache split is the provider's number rather than an estimate.

## License

MIT
