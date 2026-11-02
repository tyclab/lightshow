import type { Express } from 'express';
import { control, requireExplicitTransport } from '../control.ts';
import { asyncHandler, requestOrigin } from './common.ts';

export function attachControlRoutes(app: Express): void {
  app.put('/api/settings', (req, _res, next) => {
    if (req.body?.outputs?.armed !== undefined) requireExplicitTransport();
    next();
  });
  app.get('/api/control', (_req, res) => res.json({ ok: true, control: control.snapshot() }));
  app.post('/api/control', asyncHandler(async (req, res) => {
    res.json({ ok: true, control: await control.execute(req.body ?? {}, requestOrigin(req)) });
  }));
  app.post(['/api/play', '/api/stop', '/api/auto/start', '/api/auto/stop', '/api/sequence/play',
    '/api/sequence/stop', '/api/outputs/arm', '/api/outputs/toggle', '/api/blackout/toggle', '/api/blackout/off'],
  () => requireExplicitTransport());
  app.post('/api/outputs/disarm', asyncHandler(async (req, res) => {
    res.json({ ok: true, control: await control.execute({ action: 'disarm' }, requestOrigin(req)), armed: false });
  }));
  app.post('/api/blackout/on', asyncHandler(async (_req, res) => {
    res.json({ ok: true, control: await control.execute({ action: 'blackout' }), masterBlackout: true });
  }));
}
