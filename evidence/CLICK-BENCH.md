# Click speed / accuracy benchmark — old engine vs dsh-dexter

The test **is the old package's own acceptance fixture** — `engines/pixel/test/fixture.cs`
(a topmost WinForms window with `TARGET-A`/`TARGET-B`/`TARGET-C`). Every real click
appends `<ticks>|<control>|<x>|<y>|<foreground>` to a log, and the window publishes the
button centres as JSON, so accuracy is decided by the fixture, not by the tool's own
claim.

`tools/click-bench.mjs` drives the same fixture with both generations, in one process,
on the same machine, back to back:

- old: `dsh-click-matrix` runtime, `mouse_click`, gate armed programmatically (`source: 'bench'`)
- new: the plugin's kernel + real adapters, `kernel.act({action:'click'})`, session opened
  as `source: 'test'`

Fairness measures: same window, same button centres, one warm-up click per engine
(helper start-up is not a click cost), 120 ms between clicks, 6 rounds × 3 buttons =
18 clicks + 12 precision probes per engine.

## Result (2026-11-14, run with `--rounds 6`)

| metric | old (`dsh-click-matrix`) | new (`dsh-dexter`) | delta |
|---|---|---|---|
| clicks measured | 18 | 18 | — |
| **accuracy** (landed on the intended button) | **100 %** (18/18) | **100 %** (18/18) | 0 pp |
| inside-button probes (±70/±20 px off centre) | **100 %** | **100 %** | 0 pp |
| outside-button probes (+92 px, should miss) | **100 %** | **100 %** | 0 pp |
| **latency mean** | 289.8 ms | **283.4 ms** | **−6.4 ms** |
| latency p95 | 304.3 ms | **293.9 ms** | **−10.4 ms** |
| latency min / max | 279.9 / 304.3 ms | 277.8 / 293.9 ms | — |
| tool failures | 0 | 0 | — |

Both engines spend ~280–300 ms per click because they share the same helper and the
same smooth-move animation (160 ms default) plus the engine's own safety checks. The new
kernel's gate + audit + verify work is inside that noise: **it is not slower.**

## What the benchmark also revealed

**The rate guard is a real behavioural difference, not a regression.** The first run
(6 rounds, 31 write calls inside one minute) tripped dsh-dexter's `maxActionsPerMinute`
(30/分) on the 31st call:

```
⛔ 频率上限：最近 60 秒已经执行 30 次写动作，请等 48 秒（或调高 maxActionsPerMinute）。
```

The old engine has no such cap — it would simply keep clicking. For the quality
measurement above the cap was raised (bench-only), and the guard is reported here
instead of hidden. This is the guard the human asked for ("频率" adjustable); a
50-click batch needs `maxActionsPerMinute` raised first.

## How to reproduce

```
node tools/click-bench.mjs --rounds 6 --json baseline/local/click-bench.json
```

The fixture is compiled on demand (`build-fixture.mjs`, in-box `csc.exe`) and launched
through the shell so it is **not** a child of the benchmark process — the pixel engine
protects its own process tree, and a fixture spawned by node is refused as
"host process tree".

## Verdict

- Accuracy: identical and perfect on both (centre, near-edge and just-outside probes).
- Speed: identical within noise; the new path is marginally faster on mean and p95.
- The differences are policy, not precision: a rate cap exists, hover is audited, and
  the same click now passes one gate and lands in one trail.
