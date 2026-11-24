import type { Express } from 'express';
import { routeContext, errorHandler } from './routes/common.ts';
import type { RouteDeps } from './routes/common.ts';
import { attachLookRoutes } from './routes/look.ts';
import { attachMidiRoutes } from './routes/midi.ts';
import { attachLiveRoutes } from './routes/live.ts';
import { attachFixtureRoutes } from './routes/fixtures.ts';
import { attachCueRoutes } from './routes/cues.ts';
import { attachSetupRoutes } from './routes/setup.ts';
import { attachOutputRoutes } from './routes/outputs.ts';
import { attachIdentifyRoutes } from './routes/identify.ts';
import { attachOpenRgbRoutes } from './routes/openrgb.ts';
import { attachOpsRoutes } from './routes/ops.ts';
import { attachAudioRoutes } from './routes/audio.ts';
import { attachEffectRoutes } from './routes/effects.ts';
import { attachVoiceRoutes } from './routes/voices.ts';
import { attachSequenceRoutes } from './routes/sequence.ts';
import { attachRoomSceneRoutes } from './routes/room-scene.ts';
import { attachSupplyRoutes } from './routes/stage-supply.ts';
import { attachShowSetupRoutes } from './routes/show-setup.ts';
import { attachPerformanceRoutes } from './routes/performance.ts';
import { attachControlRoutes } from './routes/control.ts';

export type { RouteDeps, RouteContext } from './routes/common.ts';

function attachRoutes(app: Express, deps: RouteDeps): void {
  const ctx = routeContext(deps);
  attachControlRoutes(app);
  attachLookRoutes(app, ctx);
  attachMidiRoutes(app, ctx);
  attachLiveRoutes(app);
  attachFixtureRoutes(app, ctx);
  attachOpenRgbRoutes(app, ctx);
  attachCueRoutes(app, ctx);
  attachSetupRoutes(app, ctx);
  attachOutputRoutes(app, ctx);
  attachIdentifyRoutes(app, { wled: ctx.wled, hueAreas: ctx.hueAreas, broadcast: () => ctx.integrations.broadcast() });
  attachAudioRoutes(app, ctx);
  attachEffectRoutes(app, ctx);
  attachVoiceRoutes(app, ctx);
  attachSequenceRoutes(app, ctx);
  attachShowSetupRoutes(app, ctx);
  attachPerformanceRoutes(app, ctx);
  attachRoomSceneRoutes(app);
  attachSupplyRoutes(app);
  attachOpsRoutes(app, ctx);
  // Must be registered last (see errorHandler).
  app.use(errorHandler);
}

export {
  attachRoutes,
};
