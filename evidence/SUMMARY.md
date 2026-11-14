# Acceptance summary — section 6 of the repair order

Measured 2026-11-14 on the machine that runs the previous bundle. Every "pass" below
points at the file that contains the raw numbers.

| # | Criterion | Target | Measured | Verdict | Evidence |
|---|---|---|---|---|---|
| A1 | default visible tools | 4 (5 with toy) | **4** (`hands_view/act/run/status`), **5** with `toyStrokeEnabled` | **PASS** | `test/01-surface.test.mjs` 19/19; `baseline/new.json` |
| A2 | default schema bytes | ≤ 12,000 | **7,034 B** (7,691 B with toy) vs 35,201 B baseline → −80.5 % | **PASS** | `evidence/P2.md`, `baseline/new.json` |
| A3 | write-side duplication | 0 | each of move/click/drag/scroll/type/key/hotkey/clipboard owned by `hands_act` only; one implementation (`kernel.js#runOne`) | **PASS** | `test/01-surface.test.mjs` |
| A4 | single audit stream | 1 `hands.jsonl`, no control/stroke files | live run: 1 file; control/stroke trails absent; legacy pixel trail = 1 `loaded` marker only | **PASS (with D8)** | `evidence/P3.md`, `evidence/P5.md` |
| A5 | audit completeness | 20 actions → 20 rows | unit: 20/20; live: every write has approval + verify + argsHash; the e2e run added 3 executed rows for 3 writes | **PASS** | `evidence/P5.md`, `evidence/E2E.md` |
| A6 | config single source | one declaration, no `config-overrides` | 14/14: schema defaults == runtime defaults; no code path touches overrides | **PASS** | `test/03-config-single-source.test.mjs` |
| A7 | authorization | no session by default; bounded session when opened | per-write asking by default; **bare hover is free** (audited, rate-capped, refused while a button is held); a session = minutes + action budget + rate cap (15m/100/30 by default, `/dexter arm 45m 300` overrides, `Ctrl+Alt+F10` extends); **clipboard always asks**; **system targets permanently refused**; private targets still ask per write | **PASS** | `evidence/P5.md`, `DEVIATIONS.md` D12/D13 |
| A8 | stop semantics | next write refused, revocation audited | refused with reason; `decision:"stop"`, `approval:"revoked"`; live `stopRefusesNextWrite=true` | **PASS** | `evidence/P5.md` |
| A9 | human pause | ≤2 s suspend, resume after idle, all backends | live hook **59 ms**, real key **434 ms**, resume audited before the executed row, 0 spurious suspends from our own moves | **PASS** | `evidence/P5.md` |
| A10 | stroke surface | 0 by default, exactly 1 toy, description 玩法/演示, `mode:"toy"` | 0 stroke tools by default; with toy: exactly `stroke_toy`, description matches, rows carry `mode:"toy"`; point cap enforced at 400 | **PASS** | `test/01`, `test/02`, `evidence/P4.md` |
| A11 | behaviour equivalence | ≥ 19/20 | **19/20** identical outcome classes (dual-run, human pause off on both sides; an earlier quiet-desktop run gave 20/20); the one deliberate rule difference — `move` is gated in dexter, was not in pixel — is proven separately by `tools/rule-probe.mjs` | **PASS** | `evidence/P3.md`, `baseline/local/dual-run.json` |
| A12 | no new elevation | 0 UAC, never requires admin | all runs as the normal user: `Elevated=False`, `User=<machine>\<user>`, 0 `consent.exe` processes; no step asks for elevation | **PASS** | this table + `evidence/P6.md` |
| A13 | release compliance | LICENSE + THIRD-PARTY, 0 unknown licenses, no local paths/tokens/logs | MIT + THIRD-PARTY; in-repo scan 1 known / 0 unknown; prerequisites pixel MIT + uia MIT only; `check-repo: 129 files, 0 FAIL, 0 WARN` | **PASS** | `evidence/P6.md` |
| A14 | security docs | SECURITY.md with the five statements | present: local execution / zero outbound / per-action / audit is not a boundary / disclosure, plus threat model and out-of-scope list | **PASS** | `SECURITY.md`, `evidence/P6.md` |
| A15 | CI | static-only, green | workflow written (static suites only, GUI tests excluded) and validated + reproduced locally by `tools/ci-local.mjs` (3/3); **never executed on GitHub** — no repository, and pushing is on hold by the human's rule | **PREPARED, NOT PROVEN** | `evidence/P6.md` |

**Beyond the order's original six sections**, the live install produced these verified
capabilities (all with raw transcripts in the evidence folder):

| Capability | Evidence |
|---|---|
| 真机闭环：点击 → 打字 → 保存 → 从磁盘读回 | `evidence/E2E.md`（17 字符落盘 `dexter-e2e-194056`） |
| 夹具基准：点击速度/准确度 vs 旧引擎 | `evidence/CLICK-BENCH.md`（100 % / 100 %，283 ms vs 290 ms） |
| 上下文成本：每请求注入量 | `evidence/CONTEXT-COST.md`（5,134 → 1,604 tokens） |
| 剪贴板往返 | `evidence/FIX-PROGRESS.md` |
| 桌面面板（置顶工具窗口、可拖/可隐藏/可重开） | `evidence/FIXES.md`，`test/panel-*.mjs` |
| 命令契约（`/dexter` 返回 `CommandResult`、`rawInput`） | `test/06-command.test.mjs` |

**Overall:** A1–A14 pass with one documented caveat (D8, the single legacy `loaded`
marker row; the stroke licence caveat D3 is now resolved), A11 at 19/20 with the single
deliberate rule difference documented above, A12 no
violation, A15 prepared + locally reproducible but never executed on a runner. Per the
order's own gate ("任一不通过 → 不进 P6 发布"), the only remaining blocker to a public
release is A15 — which is itself gated by the human's standing no-push rule
(DEVIATIONS.md D11).

## Reproduce

```
node test/run-all.mjs                # 10/10 suites, 247 checks: surface, invariants, config,
                                     #   output contract, compat, command contract
node tools/measure-surface.mjs dexter
node tools/audit-stats.mjs all
node tools/ci-local.mjs              # validates + runs the CI definition locally (static)
node tools/dual-run.mjs              # moves the real cursor only
node tools/rule-probe.mjs            # the move-gating rule difference, no injection
node test/live-smoke.mjs             # real backends; needs a quiet desktop
node test/toy-live.mjs               # stroke helper reachability, no drag
node test/clipboard-live.mjs         # clipboard round-trip, restores the original text
node test/panel-probe.mjs            # panel window: topmost, tool window, working area
node test/panel-click.mjs            # the × really hides it to the strip
node test/panel-reopen.mjs           # closing the panel is recoverable
node tools/click-bench.mjs           # fixture benchmark, both engines
node tools/session-cost.mjs          # token usage of the current session
node tools/compare-pixel.mjs         # pixel vs dexter, side by side
```
