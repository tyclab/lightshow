# Implementation contracts

Read for this topic; paths below are relative to the repository root unless stated otherwise.

- Node 24+ runs TypeScript directly. Use erasable syntax, explicit `.ts`
  imports and `import type`; `tsc` checks types without generating runtime files.
- Edit browser code in `public-src/`; esbuild generates `public/app.bundle.js`
  and chunks. Do not commit generated assets or installation data.
- Every startup must remain disarmed. Preserve blackout, flash limits,
  photosensitivity acknowledgement, output shutdown and preview/output parity.
- Releasing a Hue Entertainment session leaves each lamp in its last streamed
  colour. Whatever disarms outside the party flow must restore or switch the
  lamps off afterwards.
- Hue application keys are revoked only at account.meethue.com; bridges refuse a
  local DELETE since API 1.31. Check which integration a key backs first.
- Keep access tokens and credentials out of logs, client state and tracked files.
- The live input's stdout (`src/live_input.py`, `src/analysis/live.py`) is NDJSON
  that `src/live-input.ts` reads line by line. Keep library logs on stderr.
