# Implementation contracts

Read for this topic; paths below are relative to the repository root unless stated otherwise.

- Node 24+ runs TypeScript directly. Use erasable syntax, explicit `.ts`
  imports and `import type`; `tsc` checks types without generating runtime files.
- Edit browser code in `public-src/`; esbuild generates `public/app.bundle.js`
  and chunks. Do not commit generated assets or installation data.
- Every startup must remain disarmed. Preserve blackout, flash limits,
  photosensitivity acknowledgement, output shutdown and preview/output parity.
- A Hue section streams to the area channel whose members equal the ones it
  recorded (`src/server/hue-sections.ts`), never to a stored number the bridge may
  have given other members; a section without exactly one such channel stays dark.
- Releasing a Hue Entertainment session leaves each lamp in its last streamed
  colour. Whatever disarms outside the party flow must restore or switch the
  lamps off afterwards.
- A Hue lamp streams the levels the renderer keeps beside its bytes (`getFine` in
  `src/server/universes.ts`), read only where they round to the final byte and never
  for a protective frame. A stage that changes a lamp's bytes after rendering holds
  without touching the levels; one that writes a lamp's channels itself (not through
  `writeDimmer` or `writeEmitters`) leaves them at zero, which streams the bytes.
- Hue application keys are revoked only at account.meethue.com; bridges refuse a
  local DELETE since API 1.31. Check which integration a key backs first.
- Keep access tokens and credentials out of logs, client state and tracked files.
- The live input's stdout (`src/live_input.py`, `src/analysis/live.py`) is NDJSON
  that `src/live-input.ts` reads line by line. Keep library logs on stderr.
