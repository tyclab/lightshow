import type { Express } from 'express';
import { asyncHandler } from './common.ts';
import { currentSupply } from '../wled-power.ts';
import type { Supply } from '../wled-power.ts';

const NONE = { ok: true, reads: false, readAt: null, models: [], gaps: [] };

/** Read-only: the WLED supply models the Stage limits its light by; `?fresh=1` reads the boards again first. */
export function attachSupplyRoutes(app: Express, supplyOf: () => Supply | null = currentSupply): void {
  app.get('/api/stage/supply', asyncHandler(async (req, res) => {
    const supply = supplyOf();
    if (supply && req.query.fresh === '1') await supply.refresh();
    res.set('Cache-Control', 'private, no-cache');
    res.json(supply ? supply.snapshot() : NONE);
  }));
}
