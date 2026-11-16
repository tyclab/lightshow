import type { Express } from 'express';
import { listLiveDevices } from '../../live-input.ts';
import { messageOf } from '../../errors.ts';
import { asyncHandler } from './common.ts';

/** The live input's devices, for the picker under Music, Live input. */
export function attachLiveRoutes(app: Express): void {
  app.get('/api/live/devices', asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await listLiveDevices()) });
    } catch (err) {
      res.json({ ok: false, error: messageOf(err) });
    }
  }));
}
