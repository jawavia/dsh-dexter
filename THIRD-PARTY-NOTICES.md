# Third-party notices

`dsh-dexter` itself is MIT (see `LICENSE`). This bundle **ships the two engines it drives
inside `vendor/`** (unmodified upstream code, MIT) plus the small derived helper described
under _Derived code inside this repository_. Vendoring is what makes a fresh install work
with no prerequisites; every license notice travels with the copy.

## Vendored engines (inside `vendor/`)

| Package | Version | Role in dsh-dexter | License | Where |
|---|---|---|---|---|
| `dsh-click-matrix` | 0.9.5 | pixel injection: Win32 helper, lattice coordinate resolution, window deny list, screenshots | MIT (dsh-click-matrix contributors) | `vendor/pixel/LICENSE` |
| `@deepseek-ai/schemastery` | 3.18.5 | its `Config` schema is imported by the pixel engine's config module | MIT | `vendor/pixel/node_modules/@deepseek-ai/schemastery/LICENSE` |
| `@deepseek-ai/cosmokit` | — | utils required by schemastery | MIT | `vendor/pixel/node_modules/@deepseek-ai/cosmokit/LICENSE` |
| `@standard-schema/spec` | — | type-level schema spec required by schemastery | MIT | `vendor/pixel/node_modules/@standard-schema/spec/LICENSE` |
| `dsh-x2` | 0.6.0-local.1 | UIA + Win32 primitives: `SendInput`, `SetCursorPos`, UI Automation PowerShell bridge, PNG encoding | MIT (Copyright (c) 2026 ql0423; local fork of `dsh-screen`, https://github.com/ql0423/dsh-screen) | `vendor/uia/LICENSE` |
| `koffi` + `@koromix/koffi-win32-x64` | 3.3.6 | FFI used for the Win32 calls, with its compiled `koffi.node` | MIT (Niels Martignène, https://koffi.dev) | `vendor/uia/node_modules/koffi/LICENSE.txt`, `vendor/uia/node_modules/@koromix/koffi-win32-x64/` |

**Nothing else is required.** The stroke toy used to load `dsh-stroke` (which declares
no license and ships an unsigned helper binary); since 2026-11-14 the toy draws
through the Win32 primitives above (`backends/toy-draw.js`), so that dependency is
gone — see `DEVIATIONS.md` D3.

A machine that already has these engines installed can still point at them with
`legacyPixelPath` / `legacyUiaPath`, `DSH_DEXTER_LEGACY_ROOT` or `local.config.json`;
an explicit path wins over the vendored copy (`backends/resolve.js`).

## Derived code inside this repository

`backends/toy-draw.js` contains the mouse-event plumbing needed to press, drag and
release the left button in one stroke. It is derived from `dsh-x2`'s private
`src/win32.js` helpers (`mouseEvent`, absolute-coordinate normalisation), MIT,
Copyright (c) 2026 ql0423. Everything else (shape geometry, caps, pacing, abort and
release guarantees) was written for this plugin.

The MIT terms that apply to that derived portion:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify,
> merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
> In no event shall the authors or copyright holders be liable for any claim, damages or
> other liability arising from the Software or its use.

## What this repository never contains

- no `.exe`: the pixel helper is compiled at runtime by its own package from
  `runtime/helper.cs` with the in-box .NET Framework compiler;
- no copied engine source, no `node_modules`, no koffi binary;
- no audit logs, no screenshots, no machine paths (see `tools/check-repo.mjs`).
