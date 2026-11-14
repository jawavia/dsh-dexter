# A/B: dsh-click-matrix (old bundle) vs dsh-dexter (new plugin)

Measured 2026-11-14 17:40–17:46 on the same machine, same user, **same coordinates**,
same window (`dexter-ab-174504.txt - Notepad`, 1124x1464 @ 380,252, point 942,952).
Each plugin was enabled alone (the other disabled, leftover helpers killed) so no tool
duplication or hotkey contention could skew the result.

## 1. Tool surface

| | old (`dsh-desktop-hands` 0.2.6) | new (`dsh-dexter` 0.1.0) |
|---|---|---|
| tools registered | **25** | **4** |
| schema weight | 35,201 B | 6,606 B |
| write entry points | `mouse_click` / `mouse_drag` / `mouse_scroll` / `mouse_batch` / `type_text` / `press_keys` / `screen_act` / `screen_sequence` | `hands_act` (one) |
| stroke | 5 tools | 0 (toy off) |

## 2. Read path — identical input, identical output

| Test | old | new | verdict |
|---|---|---|---|
| `info` | same DPI/monitors/helper/config report | same, plus target policy + session state | equivalent |
| `list` | 4 of 20 visible windows, `[禁止]` flags | 19 of 33, foreground marker | equivalent |
| `read` (UIA) | 55 elements · 1297 ms · ≈1200 tok | 48 elements · 1067 ms · ≈1207 tok | equivalent (element count differs only because new chat rows appeared between calls) |
| `capture` 640x200 | PNG `sha256:8acf7e90…`, **272 tok** (priced) | PNG **same sha256**, 172 tok (estimated) | **byte-identical image**; the token figure differs (pricing vs estimate) and the budget differs (24/32000 from the profile override vs 12/8000 new defaults) |

## 3. Write path — same point, same order

| Call | old | new |
|---|---|---|
| `move` to (942,952) | **succeeds, NOT audited at all** | succeeds, **audited**: `executed · approval=hover(free) · verify=foreground:ok` |
| `click` at (942,952) | denied · audit `mouse_click denied … reason=abort-hotkey-missing` first (the helper could not register Ctrl+Alt+F11 because stale helpers held it), then after a helper restart: `reason=denied` (human rejected the approval) | denied · `人类没有同意(rejected)`, audit trio `approval-requested → approval-denied → denied` |
| `click` at (1500,1400) (DSH's own window) | denied **before** authorization: `reason=target-window` (engine deny list) | denied **at** authorization first (`rejected`); the window deny is a second layer |

## 4. Authorization model

| | old | new |
|---|---|---|
| default | `mode=ask`, approval per action | no session, **ask per write**; bare hover free |
| arm | `/click-matrix arm <秒\|on>`; `on` = **常开直到关闭** (no expiry, no budget) | `/dexter arm [15m] [100]`; **always** minutes + action budget + rate (default 15/100/30) |
| quick adjust | `Ctrl+Alt+F12` toggles 常开/关 | `Ctrl+Alt+F12` open · `Ctrl+Alt+F10` extend · `Ctrl+Alt+F11`/`Esc` stop |
| numbers in settings | `armWindowMs` / `armClicks` (profile patch), no rate cap | `armMinutes` / `armActions` / `maxActionsPerMinute` / `hoverFree` / `askOnWrite` |
| system targets | engine window deny list (self/security/system tools) | kernel permanent deny list **plus** the engine's list |
| private targets | no special handling | chat/mail/payment/.kdbx → per-write question even inside a session |
| rate cap | only `minIntervalMs` between mutations | `maxActionsPerMinute` (sliding 60 s window) |

## 5. Audit

| | old | new |
|---|---|---|
| file | `~/.dsh/click-matrix/audit.jsonl` (861.9 KB, 1,828 rows) | `~/.dsh/dexter/audit/hands.jsonl` (hash-chained) |
| rows per click | 3 (`attempt` / `denied`+reason / `finished`) | 4 (requested / denied / denied + `argsHash`, `verify`, `capability`, `backend`) |
| hover recorded | **no** | **yes** (`hover(free)`) |
| fields | tool, decision, reason, arm, window | + capability, backend, engineTool, dryRun, argsHash, verify, durationMs, hash chain |

## 6. Failure modes this A/B exposed

1. **Old: one stale helper bricks clicking.** `abort-hotkey-missing` refused every click
   until the helper was restarted (human `/click-matrix hotkeys-retry`) — while
   `mouse_move` kept working, so it looked "half broken". In this A/B the stale helpers
   were *dexter's own* from earlier reloads.
2. **New (same root cause, smaller blast radius):** the helper's hotkey requirement is
   still the engine's; dexter now fails the same way if the combo is taken — but its
   `hands_status` will show the engine's "急停热键未注册" line only inside `info`.
3. **Both leak helper processes across reloads** — three helpers had accumulated during
   the session, each holding hotkeys. dexter's `dispose()` must kill the child, not just
   close the socket (follow-up F1 below).

## 7. Follow-ups for dsh-dexter from this comparison

- **F1** `dispose()` kills the helper process tree (or reaps it) so reloads cannot
  accumulate helpers/hotkey holders.
- **F2** surface hotkey health in `hands_status` (not only in the engine's `info` text).
- **F3** a `hands_status` line naming the *engine* deny list count, so "why was that
  window refused" is answerable without calling `screen_view info`.

## Verdict

On the **same task** the two are equivalent where it matters: the same window, the same
coordinates, the same screenshot bytes, the same UIA tree, and the same refusal when a
human does not approve. The differences are the ones the rewrite intended:

- 25 tools → 4 (surface −81 %);
- hover becomes a first-class, audited, rate-capped, button-guarded free action instead
  of an invisible ungated one;
- authorization is a bounded session (15 min / 100 actions / 30 per minute) instead of a
  latch with no expiry;
- system targets are refused by policy rather than only by the engine's window list;
- one hash-chained trail instead of a per-engine trail that never recorded hovers.

The A/B also found a real defect that unit tests could not: **helper lifetime** (F1) and
hotkey contention — worth fixing before any further installs.
