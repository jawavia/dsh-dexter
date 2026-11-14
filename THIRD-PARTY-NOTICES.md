# Third-party notices

`dsh-dexter` itself is MIT (see `LICENSE`). This bundle **ships no third-party source code except the small derived helper described
under _Derived code inside this repository_**: the desktop injection is loaded at runtime
from packages that are already installed on the machine, through explicit adapters
(`backends/legacy-*.js`). That is a deliberate licensing and safety boundary.

## Runtime prerequisites (loaded, not vendored)

| Package | Role in dsh-dexter | License | Source |
|---|---|---|---|
| `dsh-click-matrix` | pixel injection: Win32 helper, lattice coordinate resolution, window deny list, screenshots | MIT (`engines/pixel/LICENSE`, "dsh-click-matrix contributors") | separate package on the machine |
| `dsh-x2` | UIA + Win32 primitives: `SendInput`, `SetCursorPos`, UI Automation PowerShell bridge, PNG encoding | MIT (`LICENSE`, "Copyright (c) 2026 ql0423"); local fork of `dsh-screen` | https://github.com/ql0423/dsh-screen (MIT) |
| `koffi` (dependency of `dsh-x2`) | FFI used for the Win32 calls | MIT (`LICENSE.txt`, Niels Martignène) | https://koffi.dev |
| `@deepseek-ai/schemastery` | optional import, only to expose `Config` to Plugin Manager | shipped with DSH | host package |

**Nothing else is required.** The stroke toy used to load `dsh-stroke` (which declares
no license and ships an unsigned helper binary); since 2026-11-14 the toy draws
through the Win32 primitives above (`backends/toy-draw.js`), so that dependency is
gone — see `DEVIATIONS.md` D3.

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
