# dsh-dexter vs dsh-click-matrix — honest strengths and weaknesses

Written after the A/B (18+12 clicks), the fixture benchmark, the live install, and two
defects found in the wild. No marketing: every line below either has a measurement behind
it or is a stated limitation.

## First: what "per-request saving" really means

The 5,134 → 1,604 tokens figure is **context volume**, not money.

- the tool schemas sit in the prompt prefix of **every** request; with provider prompt
  caching they are re-sent as **cache reads**, which are billed at a much lower rate than
  fresh input (typically ~1/10, depends on the route);
- so 3,530 tokens × 591 requests ≈ 2.09 M is *cache-read traffic*, and in money it is
  small — the honest statement is "≈2.1 M fewer context tokens re-processed, i.e. ~3.5 k
  more free window on every turn", not "we saved 2 M tokens of budget";
- where it is real money: the **first** request of a session (cold, uncached) and any
  request that misses the cache.

## Huge advantages (measured)

| # | Advantage | Evidence |
|---|---|---|
| 1 | **Tool surface 14 → 4** (20,370 → 6,606 B, −69 %) | `tools/compare-pixel.mjs` |
| 2 | **One write entry, one audit trail**: 14 tools / per-engine files → 4 tools / one hash-chained `hands.jsonl` | live install, `evidence/P3.md` |
| 3 | **Hover becomes visible**: old engine moved the cursor with *no* authorization and *no* audit row; new: free, audited (`hover(free)`), rate-capped, refused while a button is held | `rule-probe` + live `seq=44` |
| 4 | **Bounded authorization**: old `arm on` = no expiry, no budget; new = 15 min / 100 actions / 30 per minute, then falls back to per-write asking | `evidence/P5.md` |
| 5 | **Target policy**: system/security targets refused by policy (old only relied on the engine window list); private (chat/mail/payment/.kdbx) asks per write — old had nothing | `test/02` |
| 6 | **Provable outcomes**: `approval`, `result`, `verify`, `argsHash`, `durationMs` on every row, hash-chained; old wrote 3 bare rows per click | live audit |
| 7 | **Reliability fixes found in the wild**: stale helper (owning Ctrl+Alt+F11 → every click fail-loud) now reaped on dispose (verified 1 → 0), hotkey health visible in `hands_status` | `evidence/FIXES.md` |
| 8 | **No regression in speed/accuracy**: 100 % / 100 %, mean 283.4 ms vs 289.8 ms, p95 293.9 vs 304.3 | `evidence/CLICK-BENCH.md` |

## Huge disadvantages (also real)

| # | Disadvantage | Detail |
|---|---|---|
| 1 | **Capability removal** | the old engine exposed `clipboard_get` / `clipboard_set`, `matrix_overlay` (lattice overlay), `click_matrix_doctor` (self-diagnostics), `audit_tail`, plus the `screen_view` lattice workflow. dsh-dexter exposes **none** of these as tools: clipboard is off in the adapter (`enableClipboard=false`), no overlay, no doctor, no audit query tool. If you actually used clipboard read/write, this is a functional loss, not a cleanup |
| 2 | **No skill document** | the old bundle shipped a 15 KB `SKILL.md` teaching the lattice workflow (capture → grid cell → click, cost control). New plugin has only four tool descriptions; the model must figure the lattice out from `screen_view`'s output alone |
| 3 | **No UI**: no settings panel section of its own, no "I am driving" pill during actions, no `GET /api/…/status` route | old had a web settings section, an arm pill and an HTTP status route |
| 4 | **More friction by default** | per-write approval for every click until a session is opened; old could be latched "on" once and stay. Deliberate, but a human doing 50 clicks will notice |
| 5 | **Still not self-contained** | it needs `dsh-click-matrix` + `dsh-x2` on the machine; the old bundle carried its engines. A fresh user cannot just install this and inject |
| 6 | **It is new code** | ~4,200 lines of kernel/adapter of mine vs the old engine's 5,932 + 3,538-line regression net. My suite is 116 automated checks plus a handful of live runs; the old engine survived 863 real attempts with patches for DPI, multi-monitor, UWP, DRM black frames, helper crashes. The new kernel sits in front of all of that and every step (gate, audit, target probe, verify) is new surface that has not been through a month of real use |
| 7 | **Hotkey collision in practice** | `Ctrl+Alt+F10` (extend) is owned by another process on this machine, so extending relies on the `/dexter extend` command. Found by the F2 probe, not prevented |
| 8 | **No speed gain, no big money gain** | the rewrite buys governability, not throughput: latency is a wash and the cached context saving is small in money. Anyone expecting "faster and cheaper" will be disappointed |

## The honest one-line summary

The new plugin is **better at being governed and audited, and slightly narrower**: it turns
an un-audited 14-tool engine into a 4-tool, one-gate, one-trail system with equal speed and
accuracy — at the cost of clipboard/overlay/doctor/skill guidance, the UI layer, and the
comfort of a latch that never expires. The old engine is still the one with the longer
battle history.
