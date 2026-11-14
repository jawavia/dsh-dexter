# F1 / F2 — the two defects the A/B exposed, fixed and verified

Both came out of the live A/B on 2026-11-14 (see `evidence/COMPARISON.md`).

## F1 — a reload left the pixel helper (and its hotkeys) behind

**Symptom:** after two or three plugin reloads, `Ctrl+Alt+F11` was owned by a stale
helper, so the *next* helper could not register it and the pixel engine refused every
click ("急停热键未注册 — 拒绝 arm/注入"). `mouse_move` kept working, so it looked like
"clicks broke, hovering works". Three helpers had accumulated in one afternoon.

**Two causes, both fixed:**

1. the plugin never called the pixel backend's `dispose()` at all (`index.js` only
   disposed the UIA and toy backends) → added in both cleanup paths;
2. the engine's helper client *reuses* a running helper, and then `stop()` has no child
   to send `quit` to → `backends/legacy-pixel.js` now also reaps the helper by the pid it
   reported in its `ready` message (500 ms after the graceful stop).

**Verified live:**

| step | before the fix | after the fix |
|---|---|---|
| enable plugin, `hands_view info` | 1 helper (pid 9892) | 1 helper (pid 12960) |
| `plugin_manager set_plugin enabled:false` | **still 1** (leaked, held F11) | **0** (reaped) |
| next enable | attached to the stale helper, F11 unavailable | fresh helper, `✅ Ctrl+Alt+F11 已注册` |

## F2 — hotkey health was only visible inside the engine's `info` text

`hands_status` is what a human reads first, so the hotkey state belongs on its first
screen. `backends/hotkey-probe.js` registers each combination briefly, releases it, and
reports what is free:

```
热键：Ctrl+Alt+F12 开授权 · Ctrl+Alt+F10 续期 · Ctrl+Shift+F11 软停 · Ctrl+Alt+F11 或 Esc 急停
热键：Ctrl+Alt+F10 被占用
```

On this machine `Ctrl+Alt+F10` really is owned by another process (probed before and
after the fix), which is exactly the class of problem that used to surface as a dead
click. The apply-time log also warns when the *stop* combination is taken, because that
is the one which makes the pixel engine fail-loud.

## Related: what the session actually cost

`tools/session-cost.mjs` (derived from the old bundle's `measure-click-cost.mjs`) reads
the session's zstd log and reports usage per request plus tool attribution. Result for
this session at the time of writing: **220.9 M tokens across 556 requests** (946 k
uncached input, 388.8 k output, the rest context cache reads), of which the GUI test
phase was **15.9 M (7.2 %) in 28 requests with 2 images**. Numbers are in
`baseline/local/session-cost.json`.
