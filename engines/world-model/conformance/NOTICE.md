# Notice

The conformance suite in this folder (`runner.ts`) is the official World Model
conformance suite from Meterless, Copyright 2026 Meterless, licensed under the
Apache License, Version 2.0. A copy of the license is in `LICENSE` next to this
file.

Change made for Nightlist: the default implementation path in `runner.ts` now
points at `../src/index.ts` (our implementation) instead of the Meterless
reference implementation. Nothing else in the runner was changed. The suite has
no separate fixture files; its test observations are defined inside
`runner.ts`.

The implementation under `../src/` is Nightlist's own, written against the
Meterless World Model specification.
