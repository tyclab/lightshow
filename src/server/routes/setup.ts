import { engineStatus } from '../engine.ts';
import { settings, RESTART_PATHS, CONFIG_FILE, assertSettingsDomains } from '../settings.ts';
import { showStore } from '../show-store.ts';
import { generateToken } from '../auth.ts';
import { runPreflight } from '../preflight.ts';
import * as pythonEnv from '../../python-env.ts';
import { messageOf, statusOf, codeOf } from '../../errors.ts';
import type { Express } from 'express';
import { asyncHandler, requestOrigin } from './common.ts';
import type { RouteContext } from './common.ts';


export function attachSetupRoutes(app: Express, ctx: RouteContext): void {
  const { midi, applier } = ctx;

  app.post('/api/preflight', asyncHandler(async (_req, res) => {
    const report = await runPreflight({ midi });
    res.json({ ok: true, report });
  }));

  app.get('/api/settings', (_req, res) => {
    const { settings: values, secrets } = settings.redacted();
    const pendingRestart = applier.pendingRestart();
    res.json({
      ok: true,
      settings: values,
      secrets,
      restartKeys: RESTART_PATHS,
      pendingRestart,
      python: pythonEnv.resolve(),
      running: applier.bootValues.server,
      engine: engineStatus(),
      configFile: CONFIG_FILE,
      rig: showStore.status(),
      capabilities: { routing: 'saved-and-applied-v1' },
    });
  });

  app.put('/api/settings', asyncHandler(async (req, res) => {
    try {
      const body = req.body || {};
      assertSettingsDomains(body);
      if (Object.hasOwn(body, 'artnet')) {
        const result = await showStore.commitArtnet(body.artnet);
        ctx.integrations.broadcast();
        const { settings: values, secrets } = settings.redacted();
        res.status(result.applied ? 200 : 503).json({ ok: result.applied, ...result, settings: values, secrets,
          changed: Object.keys(body.artnet || {}).map(key => `artnet.${key}`), rig: showStore.status() });
        return;
      }
      const changed = settings.update(body);
      applier.applyChanged(changed, requestOrigin(req));
      const { settings: values, secrets } = settings.redacted();
      const pendingRestart = applier.pendingRestart();
      res.json({
        ok: true,
        changed,
        settings: values,
        secrets,
        restartKeys: RESTART_PATHS,
        pendingRestart,
      });
    } catch (err) {
      // Zod errors carry the offending path; surface it rather than a bare 500.
      const issues = err && typeof err === 'object'
        ? (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues : undefined;
      const detail = issues
        ? issues.map((i) => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')
        : messageOf(err);
      res.status(statusOf(err) || (issues ? 400 : 500)).json({ ok: false, error: detail, code: codeOf(err) });
    }
  }));

  app.post('/api/settings/token/suggest', (_req, res) => {
    res.json({ ok: true, token: generateToken() });
  });
}
