# Context cost: what each bundle injects into every request

Measures the **fixed** context a bundle adds before the model does anything — the part
that is re-processed on every single request.

| Source | old `dsh-desktop-hands` 0.2.6 | new `dsh-dexter` 0.1.0 |
|---|---|---|
| tool schemas (name + description + params + output) | 25 tools · **35,174 B** | 4 tools · **6,606 B** |
| system-prompt section (pixel's safety text) | **457 chars** | none |
| skill catalog line (`click-matrix`) | **56 chars** | none |
| **fixed context per request** | **≈ 8,635 tokens** | **≈ 1,604 tokens** |
| over 591 requests (this session) | ≈ 5.10 M tokens | ≈ 0.95 M tokens |
| **saving** | — | **≈ 7,031 tokens/request (−81 %), ≈ 4.16 M over the session** |

Estimator: ~1.5 CJK chars/token, ~4 ASCII chars/token, applied identically to both sides
(absolute values ±20 %, the ratio is what matters).

## On-demand, not fixed

The old bundle also registers a `click-matrix` **skill**: 15,295 B of `SKILL.md` is loaded
only when the model opens it (≈ 5 k tokens per load). dsh-dexter has no skill; its whole
guidance is the four descriptions the model already sees.

## Per-call output (variable part)

Measured from this session's tool results:

| | calls | result text | ≈ per call |
|---|---|---|---|
| old `screen_view` + `mouse_click` | 8 | 5,527 chars | ≈ 690 chars (~250 tokens) |
| new `hands_view` + `hands_status` + `hands_act` | 21 | 13,935 chars | ≈ 663 chars (~230 tokens) |

Same order: the read side returns the same kind of payload from the same engine. Two
differences worth knowing:

- a screenshot costs the same pixels either way (the PNG was byte-identical in the A/B,
  `sha256:8acf7e90…`); only the *budget* differs (old: 24 images / 32,000 tokens per
  window from the profile override; new: 12 / 8,000 defaults);
- the new kernel appends a ~40-char verify line to each write result
  (`verify: foreground:ok`), and `hands_status` prints the policy block — both small,
  both new information the old engine never surfaced.

## Why this matters more than the token count

8.6 k vs 1.6 k per request is **7 k tokens of context window** recovered on every turn.
In this session that is 4.16 M tokens of re-read context avoided; in billing terms most
of it is cache-read traffic (cheap), but the headroom is what lets a long GUI session run
without compacting.

## Reproduce

```
node tools/context-cost.mjs --requests 591 --json baseline/local/context-cost.json
```
