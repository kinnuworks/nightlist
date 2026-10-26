# Notice

The files in this folder come from the Meterless H-MEM conformance suite:

- `runner.ts`
- `vectors/vectors.json`

Source: Meterless H-MEM (`engines/hmem/conformance/` in the meterless/meterless repository).
Copyright Meterless. Licensed under the Apache License, Version 2.0.
You may obtain a copy of the license at http://www.apache.org/licenses/LICENSE-2.0

Changes made for Nightlist: the default implementation path in `runner.ts` now points at
`../src/index.ts` instead of `../reference/src/index.ts`. `vectors/vectors.json` is unchanged.
Nothing else in either file was modified.

Distributed on an "AS IS" basis, without warranties or conditions of any kind, either
express or implied. See the license for the specific language governing permissions and
limitations.
