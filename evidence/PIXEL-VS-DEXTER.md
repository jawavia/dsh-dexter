# dsh-click-matrix (pixel) vs dsh-dexter — the comparison that matters

Scope: **only the pixel engine** and the new plugin. The x2/control engine is deliberately
excluded — it is the heavy one and comparing against it says nothing about this rewrite.

All numbers below are measured on this machine; the fixture benchmark and the session log
artifacts are in `baseline/local/`.

## 1. Context — what each injects on every request

| | dsh-click-matrix (pixel only) | dsh-dexter | delta |
|---|---|---|---|
| tools registered | **14** | **4** | −10 |
| schema bytes (desc + params + output) | **20,370 B** | **6,606 B** | −13,764 B (−68 %) |
| system-prompt section | 457 chars | none | −457 chars |
| skill catalog line | 56 chars | none | −56 chars |
| **≈ tokens per request** | **5,134** | **1,604** | **−3,530 (−69 %, 3.2× smaller)** |
| over 591 requests | ≈ 3.03 M | ≈ 0.95 M | **≈ −2.09 M** |

The old engine also ships a 15,295 B `SKILL.md` (≈5 k tokens), loaded only when the model
opens the skill — the new plugin has no skill at all.

Per-tool weight (bytes): old — `screen_view` 6,538, `mouse_batch` 4,827, `mouse_click`
2,545, `matrix_overlay` 610, `mouse_move` 1,389 …; new — `hands_act` 2,246, `hands_view`
1,940, `hands_run` 2,006, `hands_status` 414.

## 2. Speed and accuracy — the fixture benchmark

18 clicks + 12 precision probes per engine, same fixture, same button centres
(`tools/click-bench.mjs`, `--rounds 6`).

| | pixel (`mouse_click`) | dexter (`hands_act click`) |
|---|---|---|
| accuracy | **100 %** | **100 %** |
| inside-button probes | 100 % | 100 % |
| outside-button probes (should miss) | 100 % | 100 % |
| mean latency | 289.8 ms | **283.4 ms** (−6.4 ms) |
| p95 | 304.3 ms | **293.9 ms** (−10.4 ms) |
| tool failures | 0 | 0 |

Both spend ~280–300 ms because they share the same helper and the same 160 ms smooth
move. The new kernel's gate + audit + verify is inside that noise: **it is not slower.**

## 3. Tokens per call

| | pixel | dexter |
|---|---|---|
| read result | `screen_view info` prints the whole engine config block (~1.6 KB) | `hands_view info` prints the same block + target policy (~1.8 KB) |
| UIA read | 55 elements · 1,297 ms · ≈1,200 tok | 48 elements · 1,067 ms · ≈1,207 tok |
| screenshot | 640×200 · **272 tok** · `sha256:8acf7e90…` | 640×200 · **172 tok** · **same `sha256`** |
| image budget | 24 images / 32,000 tok per window (profile override) | 12 / 8,000 (defaults) |
| write result | `已拒绝…` / `光标已移动…` (~200–400 chars) | same + one `verify:` line (~40 chars) |
| audit / status call | `audit_tail`, `click_matrix_doctor` (~1–2 KB) | `hands_status` (~1.9 KB, includes policy + grant state) |

Same payloads from the same engine; the differences are the new kernel's verify line and
status block (information the old one never produced) and the screenshot budget.

## 4. Observability (what you can prove afterwards)

| | pixel | dexter |
|---|---|---|
| audit rows per click | 3 (`attempt` / `denied` / `finished`) | 4 (+ `approval` value) |
| hover recorded | **no** | **yes** (`hover(free)`) |
| fields | tool, decision, reason, window | + capability, backend, engineTool, dryRun, result, verify, argsHash, durationMs |
| hash chain | no | yes (`seq`/`prev`/`h`) |
| one trail | per-engine file | one `hands.jsonl` |

## 5. Authorization and safety surface

| | pixel | dexter |
|---|---|---|
| default | `mode=ask`, approval per action | no session → ask per write |
| arm | `/click-matrix arm <秒\|on>`; `on` = **no expiry, no budget** | `/dexter arm [15m] [100]`; **always** bounded + 30/min cap |
| hover | free **and invisible** | free, **audited**, rate-capped, refused while a button is held |
| system targets | engine window deny list | kernel permanent deny list **+** engine list |
| private targets | none | chat / mail / payment / `.kdbx` → ask per write |
| reload hygiene | helper leaked (stale helper then owns Ctrl+Alt+F11 → clicks fail-loud) | helper reaped on dispose (verified 1 → 0), hotkey health in `hands_status` |

## Verdict

- **Speed / accuracy:** equal; the new path is marginally faster on mean and p95.
- **Context:** 5,134 → 1,604 tokens per request (−69 %). Over this session's 591 requests
  that is ≈ 2.1 M fewer re-read context tokens, i.e. ~3.5 k more headroom on every turn.
- **Tokens per call:** same order; new adds a small verify line, old prints a larger
  config block. Screenshots are byte-identical; only the budget differs.
- **Everything else the rewrite bought** is in sections 4 and 5: hover is recorded, the
  trail is one chained file, authorization is bounded, system targets are refused by
  policy, and a reload no longer strands a helper holding your emergency hotkey.

## Reproduce

```
node tools/compare-pixel.mjs --json baseline/local/compare-pixel.json
node tools/click-bench.mjs --rounds 6
node tools/session-cost.mjs
```
