import { state, allocateFixtureId, universeOf, maxBrightnessOf, countUniverses, placeAddresslessFixtures } from '../state.ts';
import { resizeFixtureBuffers } from '../engine.ts';
import { parseGDTF } from '../../gdtf.ts';
import { BUILTIN_PROFILE_ID, HUE_BY_HAND, isBuiltinProfile, MAX_FIXTURES, UNIVERSE_SIZE, endChannel, fitsInUniverse, universeOverflow, registerProfile, unregisterProfile, listProfiles, getProfile, unitCapOverflow } from '../profiles.ts';
import { MAX_UNIVERSES } from '../universes.ts';
import { INTERNAL_UNIVERSE, footprintOf, hasNoAddress, isHueLamp, isWled, universeCount } from '../../shared/placement.ts';
import { isHueProfile, hueSections, hueChannels } from '../../shared/hue-lamp.ts';
import { geometryUnitIssue, unitCount } from '../../shared/rig.ts';
import { refreshHueFixtures } from '../hue-migration.ts';
import { hueProfile, hueProfileId } from '../hue-profile.ts';
import type { AreaLamp, EntertainmentArea } from '../hue.ts';
import type { HueBridgeSettings } from '../settings.ts';
import { ddpConflict } from '../ddp-routes.ts';
import { showStore, snapshotShow } from '../show-store.ts';
import { addFixtures } from '../fixture-add.ts';
import { barProfile } from '../bar-profile.ts';
import { parseOfl } from '../ofl.ts';
import { DEFAULT_WLED_MODE, ledmapUnused, wledProfile, wledSeat, wledSpan } from '../wled.ts';
import type { WledClient, WledInfo, WledLedmap, WledLook } from '../wled.ts';
import { bindingsOf, remapRoomCells, sameCells } from '../wled-refresh.ts';
import { sharedRoomScene } from '../room-scene-store.ts';
import { roomSceneSchema } from '../../shared/room-scene.ts';
import { ddpDeviceProfile, ddpDeviceProfileId } from '../ddp-device.ts';
import { profileSchema, fixtureRestoreSchema, fixtureAddSchema, wledAddSchema, wledRefreshSchema, ddpAddSchema, hueAddSchema, validate } from '../validation.ts';
import * as output from '../output.ts';
import { defaultHueBridgeId } from '../settings.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express, Response } from 'express';
import type { Fixture, Profile } from '../../types/rig.ts';
import { asyncHandler, resolveHueBridge, uploadGdtf, uploadOfl } from './common.ts';
import type { RouteContext } from './common.ts';

/**
 * The patch: fixture profiles (GDTF, the Open Fixture Library, a bar built
 * from its manual), WLEDs and other DDP pixel devices, Hue lamps, the fixtures
 * themselves, and the show file. OpenRGB devices are routes/openrgb.ts.
 */
export function attachFixtureRoutes(app: Express, ctx: RouteContext): void {
  const { integrations, oflLibrary, wled, hueAreas } = ctx;

  // ─── GDTF / Profiles / Fixtures / Show ────────────────────────────────────
  app.post('/api/gdtf/parse', uploadGdtf.single('gdtf'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    try {
      const result = await parseGDTF(req.file.buffer);
      res.json({ ok: true, fixture: result });
    } catch (err) {
      console.error('GDTF parse error:', messageOf(err));
      res.status(400).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── Open Fixture Library ─────────────────────────────────────────────────
  // A downloaded OFL fixture file (no internet needed), or a fixture searched
  // for and fetched from the library online. Both answer as /api/gdtf/parse
  // does, so the page offers their modes the same way.
  app.post('/api/ofl/parse', uploadOfl.single('ofl'), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    let json: unknown;
    try {
      json = JSON.parse(req.file.buffer.toString('utf8'));
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'That file is not JSON: an Open Fixture Library fixture is a .json file' });
    }
    try {
      const manufacturer = typeof req.body?.manufacturer === 'string' ? req.body.manufacturer.trim() : null;
      res.json({ ok: true, fixture: parseOfl(json, { manufacturer }) });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  });

  app.get('/api/ofl/search', asyncHandler(async (req, res) => {
    try {
      const results = await oflLibrary.search(typeof req.query.q === 'string' ? req.query.q : '');
      res.json({ ok: true, results });
    } catch (err) {
      res.status(statusOf(err) || 502).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.get('/api/ofl/fixture/:manufacturer/:fixture', asyncHandler(async (req, res) => {
    try {
      const fixture = await oflLibrary.fixture(String(req.params.manufacturer), String(req.params.fixture));
      res.json({ ok: true, fixture });
    } catch (err) {
      res.status(statusOf(err) || 502).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── WLED ─────────────────────────────────────────────────────────────────
  // Find the WLEDs on the network, and add one: its profile from what it says
  // it is, patched on universes of its own and sent DDP (ddp-routes.ts).
  app.get('/api/wled/discover', asyncHandler(async (_req, res) => {
    try {
      const found = await wled.discover();
      const devices = await Promise.all(found.map(async (device) => {
        const patched = state.fixtures.filter((f) => f.output?.protocol === 'ddp' && f.output.host === device.host);
        const base = { ...device, patched: patched.length ? patched.map((f) => f.label).join(', ') : null };
        try {
          const info = await wled.info(device.host);
          let segments: number | null = null;
          try {
            segments = wled.segments ? (await wled.segments(device.host, info)).length : null;
          } catch (_) { /* an older WLED: added whole */ }
          return { ...base, name: info.name, leds: info.leds, rgbw: info.rgbw, matrix: info.matrix, version: info.version, segments };
        } catch (err) {
          return { ...base, error: messageOf(err) };
        }
      }));
      res.json({ ok: true, devices });
    } catch (err) {
      res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.post('/api/wled/add', asyncHandler(async (req, res) => {
    try {
      const { host, label, segments: bySegment, mode = DEFAULT_WLED_MODE, zones } = validate(wledAddSchema, req.body || {}, 'wled');
      const look: WledLook = { mode, zones };
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }
      // A DDP device that is not a WLED is never asked for its info, segments or not.
      const sameHost = state.fixtures.find((f) => f.output?.protocol === 'ddp' && f.output.host.toLowerCase() === host.toLowerCase());
      if (sameHost && (!bySegment || !isWled(sameHost))) return res.status(409).json({ ok: false, error: `${host} is patched already, as "${sameHost.label}"` });
      if (bySegment) return await addSegments(res, host, label, look);

      const info = await wled.info(host);
      const ledmap = await ledmapFor(wled, host, info, look);
      const profile = wledProfile(info, host, null, look, ledmap);
      // The profile is named for the WLED's own address (its MAC), so the same
      // device found at a new IP is the fixture that is already there, in
      // whatever mode it was patched.
      const seat = wledSeat(profile.id);
      const sameDevice = state.fixtures.find((f) => wledSeat(f.profileId) === seat);
      if (sameDevice) {
        return res.status(409).json({ ok: false, error: `${info.name} is patched already, as "${sameDevice.label}"; change its address in the patch table` });
      }
      // No DMX address: the server places it on universes of its own.
      const fixture: Fixture = {
        id: -1, label: (label || info.name).slice(0, 64), address: 1, universe: INTERNAL_UNIVERSE, profileId: profile.id, maxBrightness: 255,
        override: null, position: null, group: null, geometry: null, output: { protocol: 'ddp', host, ...wledSpan(info, null, look, ledmap) },
      };
      const added = addFixtures([fixture], [profile], `${info.name} would put the patch on more than the ${MAX_UNIVERSES} universes this server transmits`,
        () => integrations.broadcast());
      if ('error' in added) return res.status(400).json({ ok: false, error: added.error });
      res.json({ ok: true, fixture: added.fixtures[0], profile, info, ledmap: ledmapAnswer(ledmap, info) });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  }));

  /**
   * A WLED patched segment by segment: a fixture for each of its segments not
   * patched yet, each sent to its own LEDs, so the stage plot can put the
   * booth's front and its sides where they are.
   */
  async function addSegments(res: Response, host: string, label: string | undefined, look: WledLook) {
    if (!wled.segments) return res.status(501).json({ ok: false, error: 'This server cannot read WLED segments' });
    const info = await wled.info(host);
    const segments = await wled.segments(host, info);
    if (!segments.length) return res.status(400).json({ ok: false, error: `${info.name} has no segments with LEDs in them` });
    const ledmap = await ledmapFor(wled, host, info, look);
    const built = segments.map((segment) => ({ segment, profile: wledProfile(info, host, segment, look, ledmap) }));
    const patchedSeats = new Set(state.fixtures.map((f) => wledSeat(f.profileId)));
    const fresh = built.filter(({ profile }) => !patchedSeats.has(wledSeat(profile.id)));
    if (!fresh.length) return res.status(409).json({ ok: false, error: `Every segment of ${info.name} is patched already` });
    if (state.fixtures.length + fresh.length > MAX_FIXTURES) {
      return res.status(400).json({ ok: false, error: `${fresh.length} segments would take the patch past ${MAX_FIXTURES} fixtures` });
    }
    const draft: Fixture[] = [];
    for (const { segment, profile } of fresh) {
      draft.push({
        id: -1 - draft.length, label: `${label || info.name} · ${segment.name}`.slice(0, 64), address: 1, universe: INTERNAL_UNIVERSE,
        profileId: profile.id, maxBrightness: 255, override: null, position: null, group: null, geometry: null,
        output: {
          protocol: 'ddp', host, at: segment.at, ...(segment.rowStride ? { rowStride: segment.rowStride } : {}), ...wledSpan(info, segment, look, ledmap),
        },
      });
    }
    const added = addFixtures(draft, fresh.map(({ profile }) => profile as Profile),
      `${info.name}'s segments would put the patch on more than the ${MAX_UNIVERSES} universes this server transmits`, () => integrations.broadcast());
    if ('error' in added) return res.status(400).json({ ok: false, error: added.error });
    return res.json({ ok: true, fixtures: added.fixtures, profiles: fresh.map(({ profile }) => profile), info, segments: fresh.length, ledmap: ledmapAnswer(ledmap, info) });
  }

  /**
   * A patched WLED read again: its LEDs, its segment and the ledmap it has loaded, under the same
   * profile id, so the fixture keeps its place in the patch, its shows and its id. When the cells
   * change on the same grid, the Stage room's bindings follow each cell to its new index, and a
   * binding whose LED the ledmap no longer keeps is dropped.
   *
   * A refresh that would change the fixture's cell count or its grid writes nothing: it answers what
   * would change (`applied: false`), and only a second call confirming that count and grid (`confirm`)
   * applies it. `dryRun` only ever answers. One that keeps both applies at once.
   */
  app.post('/api/wled/refresh', asyncHandler(async (req, res) => {
    try {
      const { fixtureId, dryRun = false, confirm } = validate(wledRefreshSchema, req.body || {}, 'wled');
      const fixture = state.fixtures.find((f) => f.id === fixtureId);
      if (!fixture || !isWled(fixture) || fixture.output?.protocol !== 'ddp') {
        return res.status(404).json({ ok: false, error: `Fixture ${fixtureId} is not a WLED in the patch` });
      }
      const seat = wledSeat(fixture.profileId);
      if (seat !== fixture.profileId) {
        return res.status(400).json({ ok: false, error: `"${fixture.label}" is patched as a wash, zones or a strobe panel: only a fixture patched pixel by pixel takes its LEDs from the ledmap` });
      }
      const output = fixture.output, host = output.host, look: WledLook = { mode: 'pixels' };
      const asked = JSON.stringify([fixture.profileId, output]);
      const info = await wled.info(host);
      const segmentId = seat.match(/-seg(\d+)$/)?.[1];
      let segment = null;
      if (segmentId !== undefined) {
        if (!wled.segments) return res.status(501).json({ ok: false, error: 'This server cannot read WLED segments' });
        segment = (await wled.segments(host, info)).find((entry) => entry.id === Number(segmentId)) ?? null;
        if (!segment) return res.status(409).json({ ok: false, error: `${info.name} has no segment ${Number(segmentId) + 1} any more: patch its segments again` });
      }
      const ledmap = await ledmapFor(wled, host, info, look);
      // The device answers over several requests: build on the fixture as it is now, and only if its patch did not change meanwhile.
      const current = state.fixtures.find((f) => f.id === fixtureId);
      if (!current || JSON.stringify([current.profileId, current.output]) !== asked) {
        return res.status(409).json({ ok: false, error: `"${fixture.label}" was re-patched or removed while its WLED was read: read it again` });
      }
      const profile = wledProfile(info, host, segment, look, ledmap) as Profile;
      if (profile.id !== current.profileId) {
        return res.status(409).json({ ok: false, error: `${host} answers as another WLED (${info.name}): change "${current.label}"'s address first` });
      }
      const before = getProfile(current);
      const next: Fixture = { ...current, output: { protocol: 'ddp', host, ...(output.port ? { port: output.port } : {}),
        ...(segment ? { at: segment.at, ...(segment.rowStride ? { rowStride: segment.rowStride } : {}) } : {}), ...wledSpan(info, segment, look, ledmap) } };
      const draft = state.fixtures.map((f) => (f.id === fixtureId ? next : { ...f }));
      const profileOf = (f: Pick<Fixture, 'profileId'>) => (f.profileId === profile.id ? profile : getProfile(f));
      placeAddresslessFixtures(draft, profileOf);
      const problem = geometryUnitIssue(current.geometry, profile) || unitCapOverflow(draft, profileOf) || ddpConflict(draft, profileOf)
        || (countUniverses(draft, profileOf) > MAX_UNIVERSES ? `${info.name} would put the patch on more than the ${MAX_UNIVERSES} universes this server transmits` : null);
      if (problem) return res.status(400).json({ ok: false, error: problem });
      // The held room, not a copy: the remap builds a new room and leaves this one as it is.
      const rooms = ctx.roomScene ?? sharedRoomScene();
      const { room } = rooms.peek();
      const remap = room ? remapRoomCells(room, fixtureId, before, profile) : null;
      // Cells on another grid cannot be followed: the room's bindings for the fixture still name the old cells.
      const stale = room && !remap && !sameCells(before, profile) ? bindingsOf(room, fixtureId) : 0;
      const remapped = remap && (remap.moved || remap.dropped) ? roomSceneSchema.safeParse(remap.room) : null;
      if (remapped && !remapped.success) return res.status(400).json({ ok: false, error: 'The Stage room would not hold the refreshed cells', issues: remapped.error.issues });
      const cells = { before: unitCount(before), after: unitCount(profile) };
      const grid = { before: gridSize(before), after: gridSize(profile) };
      const answer = {
        cells, grid, ledmap: ledmapAnswer(ledmap, info),
        room: remap ? { moved: remap.moved, dropped: remap.dropped } : stale ? { moved: 0, dropped: 0, stale } : null,
        // A full grid is what a pixel feed sized to it (the browser helper's --panels, the curtain feed) can drive.
        fullGrid: { before: isFullGrid(before), after: isFullGrid(profile) },
      };
      const reshaped = cells.after !== cells.before || !sameSize(grid.before, grid.after);
      if (dryRun || (reshaped && confirm === undefined)) {
        return res.json({ ok: true, applied: false, ...answer, fixture: current, profile, info });
      }
      if (confirm !== undefined && (confirm.cells !== cells.after || !sameSize(confirm.grid, grid.after))) {
        return res.status(409).json({ ok: false, error: `${info.name} now reads as ${cellsOn(cells.after, grid.after)}, not the ${cellsOn(confirm.cells, confirm.grid)} confirmed: read it again`, ...answer });
      }
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      state.fixtures = draft;
      placeAddresslessFixtures();
      resizeFixtureBuffers();
      if (remapped?.success) rooms.save(remapped.data);
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, applied: true, ...answer, fixture: next, profile, info });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── DDP pixel devices ────────────────────────────────────────────────────
  // A DDP receiver that is not a WLED has nothing to ask, so its size comes
  // with the request. Its output says so, and it is only ever sent frames.
  app.post('/api/ddp/add', (req, res) => {
    try {
      const { host, label, columns, rows, position } = validate(ddpAddSchema, req.body || {}, 'ddp');
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }
      const sameHost = state.fixtures.find((f) => f.output?.protocol === 'ddp' && f.output.host.toLowerCase() === host.toLowerCase());
      if (sameHost) return res.status(409).json({ ok: false, error: `${host} is patched already, as "${sameHost.label}"` });
      const name = label || host;
      // A profile of that id another fixture is on stays its own.
      const used = new Set(state.fixtures.map((f) => f.profileId));
      const base = ddpDeviceProfileId(host);
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base.slice(0, 120)}-${n}`;
      const profile = ddpDeviceProfile({ host, label: name, columns, rows }, id);
      const fixture: Fixture = {
        id: -1, label: name.slice(0, 64), address: 1, universe: INTERNAL_UNIVERSE, profileId: profile.id, maxBrightness: 255,
        override: null, position: position ? { ...position } : null, group: null, geometry: null,
        output: { protocol: 'ddp', host, device: 'generic' },
      };
      const added = addFixtures([fixture], [profile], `${name} would put the patch on more than the ${MAX_UNIVERSES} universes this server transmits`,
        () => integrations.broadcast());
      if ('error' in added) return res.status(400).json({ ok: false, error: added.error });
      res.json({ ok: true, fixture: added.fixtures[0], profile });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  });

  app.post('/api/profiles', (req, res) => {
    try {
      const profile = validate(profileSchema, req.body, 'profile');
      const hue = hueProfileBlocked(profile);
      if (hue) return res.status(400).json({ ok: false, error: hue });
      // Re-importing a profile that is already patched changes every fixture
      // on it at once — a GDTF that now counts its fine channels is a channel
      // longer — so those fixtures are held to the same rules as patching them.
      const blocked = profileChangeBlocked(profile);
      if (blocked) return res.status(400).json({ ok: false, error: blocked });
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      placeAddresslessFixtures();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // A bar profile from its cell count and channel order (bar-profile.js).
  // `?dryRun=1` answers with the profile without adding it, for the preview.
  app.post('/api/profiles/bar', (req, res) => {
    try {
      const profile = barProfile(req.body || {});
      if (req.query.dryRun === '1') return res.json({ ok: true, profile });
      if (isBuiltinProfile(profile.id)) return res.status(400).json({ ok: false, error: 'That id is a built-in profile' });
      const hue = hueProfileBlocked(profile);
      if (hue) return res.status(400).json({ ok: false, error: hue });
      const blocked = profileChangeBlocked(profile);
      if (blocked) return res.status(400).json({ ok: false, error: blocked });
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      placeAddresslessFixtures();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, profile });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  /** Why replacing a profile with `profile` would break the patch, or null. */
  function profileChangeBlocked(profile: Profile): string | null {
    const users = state.fixtures.filter((f) => f.profileId === profile.id);
    for (const fixture of users) {
      const mapIssue = geometryUnitIssue(fixture.geometry, profile);
      if (mapIssue) return mapIssue;
      const overflow = hasNoAddress(fixture)
        ? universeOverflow(fixture.label, 1, profile, INTERNAL_UNIVERSE)
        : universeOverflow(fixture.label, fixture.address, profile, universeOf(fixture));
      if (overflow) return overflow;
    }
    if (!users.length) return null;
    const profiles = listProfiles();
    const profileOf = (f: Pick<Fixture, 'profileId'>) => (f.profileId === profile.id ? profile : profiles[f.profileId] || profiles[BUILTIN_PROFILE_ID]);

    return unitCapOverflow(state.fixtures, profileOf) || ddpConflict(state.fixtures, profileOf);
  }

  app.delete('/api/profiles/:id', (req, res) => {
    const id = req.params.id;
    if (isBuiltinProfile(id)) return res.status(400).json({ ok: false, error: 'Cannot remove built-in profile' });
    const inUse = state.fixtures.some((f) => f.profileId === id);
    if (inUse) return res.status(400).json({ ok: false, error: 'Profile is in use by patched fixtures' });
    unregisterProfile(id);
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true });
  });

  /**
   * Add fixtures: one generic par behind whatever is on the rig's default
   * universe, as the patch table's "+" always has — or, with a body, `count`
   * of one profile from an address on a universe, one after another. A
   * universe that fills goes on to the next, and a strip longer than a
   * universe starts at channel 1 of universes of its own, so "sixteen bars
   * from address 1" is one request rather than sixteen and some arithmetic.
   */
  app.post('/api/fixtures', (req, res) => {
    let body;
    try {
      body = validate(fixtureAddSchema, req.body || {}, 'fixtures');
    } catch (err) {
      return res.status(400).json({ ok: false, error: messageOf(err) });
    }
    const count = body.count ?? 1;
    if (state.fixtures.length + count > MAX_FIXTURES) {
      return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
    }
    const profiles = listProfiles();
    const profileId = body.profileId ?? BUILTIN_PROFILE_ID;
    const profile = profiles[profileId];
    if (!profile) return res.status(400).json({ ok: false, error: `No profile "${profileId}"` });
    if (isHueProfile(profile)) return res.status(400).json({ ok: false, error: HUE_BY_HAND });

    // What is taken, per universe: the last channel used on it, a strip
    // running on into it included, and new fixtures as they are placed.
    const lastUsed = new Map<number, number>();
    const take = (universe: number, address: number) => {
      for (const part of footprintOf(universe, address, profile)) {
        lastUsed.set(part.universe, Math.max(lastUsed.get(part.universe) || 0, part.last));
      }
    };
    for (const fix of state.fixtures) {
      for (const part of footprintOf(universeOf(fix), fix.address, profiles[fix.profileId] || profiles[BUILTIN_PROFILE_ID])) {
        lastUsed.set(part.universe, Math.max(lastUsed.get(part.universe) || 0, part.last));
      }
    }
    const span = universeCount(profile);
    const placed: { universe: number; address: number }[] = [];
    let universe = body.universe ?? state.artnet.universe;
    let address = body.address ?? (lastUsed.get(universe) || 0) + 1;
    for (let k = 0; k < count; k++) {
      if (span > 1) {
        // A strip: channel 1 of as many empty universes as it runs over.
        const free = (u: number) => [...Array(span).keys()].every((j) => !lastUsed.has(u + j));
        if (address !== 1 || !free(universe)) {
          while (universe <= 32767 && !free(universe)) universe++;
          address = 1;
        }
      } else if (!fitsInUniverse(address, profile.channelCount)) {
        if (k === 0 && body.address !== undefined) {
          return res.status(400).json({
            ok: false,
            error: `A ${profile.channelCount}-channel fixture at ${address} would end at `
              + `${endChannel(address, profile.channelCount)}, past the ${UNIVERSE_SIZE}-channel universe`,
          });
        }
        // Full: behind whatever is on the next universe that has room.
        do {
          universe++;
          address = (lastUsed.get(universe) || 0) + 1;
        } while (universe <= 32767 && !fitsInUniverse(address, profile.channelCount));
      }
      if (universe > 32767) return res.status(400).json({ ok: false, error: 'No room left on any universe' });
      placed.push({ universe, address });
      take(universe, address);
      if (span > 1) { universe += span; address = 1; } else address += profile.channelCount;
    }

    const labelOf = (id: number, k: number) => (body.label ? (count > 1 ? `${body.label} ${k + 1}` : body.label) : `Fixture ${id + 1}`);
    const draft = placed.map((p, k) => ({ id: -1 - k, label: labelOf(state.fixtures.length + k, k), ...p, profileId }));
    const next = [...state.fixtures, ...draft];
    const tooMany = unitCapOverflow(next);
    if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
    const wled = ddpConflict(next, getProfile);
    if (wled) return res.status(400).json({ ok: false, error: wled });
    if (countUniverses(next) > MAX_UNIVERSES) {
      return res.status(400).json({
        ok: false,
        error: `${count > 1 ? 'These fixtures' : `Universe ${placed[0].universe}`} would put the patch on more than the ${MAX_UNIVERSES} `
          + 'universes this server transmits',
      });
    }
    const ids: number[] = [];
    placed.forEach((p, k) => {
      const id = allocateFixtureId();
      ids.push(id);
      state.fixtures.push({
        id,
        label: labelOf(id, k),
        address: p.address,
        universe: p.universe,
        profileId,
        maxBrightness: 255,
        override: null,
      });
    });
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true, fixtures: ids, placed });
  });

  /** The area a bridge streams, or the answer that says why there is none. */
  async function hueArea(bridge: HueBridgeSettings, res: Response): Promise<EntertainmentArea | null> {
    const name = bridge.label || bridge.id;
    if (!bridge.host || !bridge.username) { res.status(409).json({ ok: false, error: `Pair with "${name}" first.` }); return null; }
    if (!bridge.entertainmentId) { res.status(409).json({ ok: false, error: `Pick an entertainment area for "${name}" first.` }); return null; }
    let area;
    try {
      area = (await hueAreas(bridge.host, bridge.username)).find((a) => a.id === bridge.entertainmentId);
    } catch (err) {
      res.status(502).json({ ok: false, error: messageOf(err) });
      return null;
    }
    if (!area) res.status(404).json({ ok: false, error: `"${name}" has no such entertainment area any more; pick one again.` });
    return area || null;
  }

  /** The fixture a lamp of a bridge's area is patched as already: on its profile, or on one of its channels. */
  function patchedAs(bridgeId: string, lamp: AreaLamp): Fixture | null {
    const profileId = hueProfileId(lamp.id, bridgeId);
    return state.fixtures.find((f) => f.output?.protocol === 'hue' && f.output.bridge === bridgeId
      && (f.profileId === profileId || hueChannels(f.output).some((ch) => lamp.channels.includes(ch)))) || null;
  }

  /** The lamps of the area a bridge streams, their sections, and what each can show. */
  app.get(['/api/hue/lamps', '/api/hue/:bridge/lamps'], asyncHandler(async (req, res) => {
    const bridge = resolveHueBridge(req, res);
    if (!bridge) return;
    const area = await hueArea(bridge, res);
    if (!area) return;
    res.json({
      ok: true,
      bridge: { id: bridge.id, label: bridge.label },
      area: { id: area.id, name: area.name },
      channels: area.channels,
      lamps: area.lamps.map((lamp) => ({ ...lamp, shows: hueProfile(lamp, bridge.id)?.modeName ?? null })),
    });
  }));

  /** Patch lamps of a bridge's area: those named, or every one not patched yet. */
  app.post(['/api/hue/add', '/api/hue/:bridge/add'], asyncHandler(async (req, res) => {
    let body;
    try {
      body = validate(hueAddSchema, req.body || {}, 'hue add');
    } catch (err) {
      return res.status(400).json({ ok: false, error: messageOf(err) });
    }
    const bridge = resolveHueBridge(req, res);
    if (!bridge) return;
    const area = await hueArea(bridge, res);
    if (!area) return;

    const wanted = body.lamps ? new Set(body.lamps) : body.channels
      ? new Set(area.lamps.filter((lamp) => lamp.channels.some((channel) => body.channels!.includes(channel))).map((lamp) => lamp.id)) : null;
    if (body.channels?.some((channel) => !area.channels.some((entry) => entry.id === channel))) {
      return res.status(404).json({ ok: false, error: 'The requested channel is not in this entertainment area' });
    }
    for (const id of wanted || []) {
      const lamp = area.lamps.find((l) => l.id === id);
      if (!lamp) return res.status(404).json({ ok: false, error: `"${area.name}" has no lamp ${id}` });
      const already = patchedAs(bridge.id, lamp);
      if (already) return res.status(409).json({ ok: false, error: `${lamp.name || 'That lamp'} is patched already, as "${already.label}"` });
    }
    const fresh = area.lamps.filter((lamp) => (wanted ? wanted.has(lamp.id) : !patchedAs(bridge.id, lamp)));
    if (!fresh.length) return res.status(409).json({ ok: false, error: `Every lamp of "${area.name}" is patched already` });
    const built = fresh.map((lamp) => ({ lamp, profile: hueProfile(lamp, bridge.id) }));
    const unread = built.find((b) => !b.profile);
    if (unread) {
      const { lamp } = unread;
      return res.status(502).json({
        ok: false, error: `The bridge would not say what ${lamp.name ? `"${lamp.name}"` : `channel ${lamp.channels[0]}`} can show; try again`,
      });
    }
    if (state.fixtures.length + fresh.length > MAX_FIXTURES) {
      return res.status(400).json({ ok: false, error: `${fresh.length} lamps would take the patch past ${MAX_FIXTURES} fixtures` });
    }

    const profiles = [...new Map(built.map(({ profile }) => [(profile as Profile).id, profile as Profile])).values()];
    const draft: Fixture[] = built.map(({ lamp, profile }, k) => ({
      id: -1 - k, label: (lamp.name || `Hue ${lamp.channels[0]}`).slice(0, 64), address: 1, universe: INTERNAL_UNIVERSE,
      profileId: (profile as Profile).id, maxBrightness: 255, override: null,
      output: { protocol: 'hue', bridge: bridge.id, channels: [...lamp.channels] },
    }));
    const added = addFixtures(draft, profiles, `These lamps would put the patch on more than the ${MAX_UNIVERSES} universes this server renders`,
      () => integrations.broadcast());
    if ('error' in added) return res.status(400).json({ ok: false, error: added.error });
    res.json({ ok: true, fixtures: added.fixtures, profiles, bridge: { id: bridge.id, label: bridge.label }, area: { id: area.id, name: area.name } });
  }));

  app.post(['/api/hue/refresh', '/api/hue/:bridge/refresh'], asyncHandler(async (req, res) => {
    const bridge = resolveHueBridge(req, res);
    if (!bridge) return;
    const area = await hueArea(bridge, res);
    if (!area) return;
    const { updates, skipped } = refreshHueFixtures(state.fixtures, listProfiles(), bridge.id, area.lamps);
    if (!updates.length) return res.json({ ok: true, refreshed: [], skipped });
    const byId = new Map(updates.map((update) => [update.id, update.profile]));
    const draft = state.fixtures.map((fixture) => ({ ...fixture, profileId: byId.get(fixture.id)?.id || fixture.profileId }));
    const refreshedProfiles = new Map(updates.map(({ profile }) => [profile.id, profile]));
    const profileOf = (fixture: Pick<Fixture, 'profileId'>) => refreshedProfiles.get(fixture.profileId) || getProfile(fixture);
    placeAddresslessFixtures(draft, profileOf);
    const mapIssue = draft.map((fix) => geometryUnitIssue(fix.geometry, profileOf(fix))).find(Boolean);
    const problem = mapIssue || unitCapOverflow(draft, profileOf) || (countUniverses(draft, profileOf) > MAX_UNIVERSES ? 'The refreshed patch exceeds the universe limit' : null);
    if (problem) return res.status(400).json({ ok: false, error: problem });
    for (const { profile } of updates) registerProfile(profile);
    state.fixtures = draft;
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true, refreshed: updates.map(({ id }) => id), skipped });
  }));

  // Answers with the fixture that was removed and its position, so the client
  // can offer an undo. The id is stable because external bindings refer to it.
  app.delete('/api/fixtures/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (state.fixtures.length <= 1) return res.status(400).json({ ok: false, error: 'Must have at least one fixture' });
    const index = state.fixtures.findIndex((f) => f.id === id);
    if (index < 0) return res.status(404).json({ ok: false, error: 'No such fixture' });

    const [removed] = state.fixtures.splice(index, 1);
    placeAddresslessFixtures();
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    // A Hue lamp's, a WLED's or an OpenRGB device's place is the server's own,
    // and goes back wherever it fits.
    const addressless = hasNoAddress(removed);
    res.json({
      ok: true,
      index,
      fixture: {
        id: removed.id,
        label: removed.label,
        address: addressless ? undefined : removed.address,
        universe: addressless ? undefined : universeOf(removed),
        profileId: removed.profileId,
        productId: removed.productId,
        hardware: removed.hardware,
        admission: removed.admission,
        maxBrightness: maxBrightnessOf(removed),
        position: removed.position || null,
        group: removed.group || null,
        geometry: removed.geometry || null,
        emission: removed.emission || null,
        output: removed.output || null,
        override: removed.override,
      },
    });
  });

  /**
   * Put a deleted fixture back at its old index.
   *
   * Held to exactly the same rules as adding one — the patch may have changed
   * in the seconds the undo was on screen, and an undo that reintroduces an
   * overlap or overflows a universe is worse than no undo at all.
   */
  app.post('/api/fixtures/restore', (req, res) => {
    try {
      const { index, fixture } = validate(fixtureRestoreSchema, req.body || {}, 'fixture-restore');
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }

      const profiles = listProfiles();
      const profileId = profiles[fixture.profileId] ? fixture.profileId : BUILTIN_PROFILE_ID;
      const mapIssue = geometryUnitIssue(fixture.geometry, profiles[profileId]);
      if (mapIssue) return res.status(400).json({ ok: false, error: mapIssue });
      const addressless = hasNoAddress(fixture);
      if (isHueLamp(fixture) !== isHueProfile(profiles[profileId])) return res.status(400).json({ ok: false, error: HUE_BY_HAND });
      // A lamp from before several bridges were possible names none: it is
      // the first bridge's, as the show loader makes it.
      const hueOut = fixture.output?.protocol === 'hue'
        ? { ...fixture.output, bridge: fixture.output.bridge || defaultHueBridgeId(output.getHueConfig().bridges) } : null;
      // A WLED's or an OpenRGB device's output comes back with it; Hue is settled above.
      const deviceOut = fixture.output && (fixture.output.protocol === 'ddp' || fixture.output.protocol === 'openrgb') ? fixture.output : null;
      const channels = hueOut ? hueChannels(hueOut) : [];
      if (hueOut && channels.length !== hueSections(profiles[profileId])) {
        return res.status(400).json({ ok: false, error: 'The lamp channels do not match its profile sections' });
      }
      const sameChannel = !hueOut ? null
        : state.fixtures.find((f) => f.output?.protocol === 'hue' && f.output.bridge === hueOut.bridge && hueChannels(f.output).some((ch) => channels.includes(ch)));
      if (sameChannel) {
        return res.status(409).json({ ok: false, error: `Hue channel ${channels.join(', ')} of bridge ${hueOut?.bridge} is patched already, as "${sameChannel.label}"` });
      }
      if (!addressless && fixture.address === undefined) {
        return res.status(400).json({ ok: false, error: 'fixture-restore: fixture.address is required for a fixture on DMX' });
      }
      const overflow = addressless
        ? universeOverflow(fixture.label, 1, profiles[profileId], INTERNAL_UNIVERSE)
        : universeOverflow(fixture.label, fixture.address as number, profiles[profileId], fixture.universe ?? state.artnet.universe);
      if (overflow) return res.status(400).json({ ok: false, error: overflow });

      const restored = {
        id: fixture.id,
        label: fixture.label,
        address: addressless ? 1 : fixture.address as number,
        universe: addressless ? INTERNAL_UNIVERSE : fixture.universe !== undefined ? fixture.universe : state.artnet.universe,
        profileId,
        maxBrightness: fixture.maxBrightness !== undefined ? fixture.maxBrightness : 255,
        position: fixture.position || null,
        group: fixture.group || null,
        geometry: fixture.geometry || null,
        emission: fixture.emission || null,
        output: hueOut || deviceOut,
        override: fixture.override || null,
        productId: fixture.productId, hardware: fixture.hardware, admission: fixture.admission,
      };

      if (state.fixtures.some((existing) => existing.id === restored.id)) {
        return res.status(409).json({ ok: false, error: 'That fixture id is already in use' });
      }

      const at = Math.max(0, Math.min(state.fixtures.length, index));
      const proposed = state.fixtures.map((f) => ({ ...f }));
      proposed.splice(at, 0, { ...restored } as Fixture);
      placeAddresslessFixtures(proposed);
      const tooMany = unitCapOverflow(proposed);
      if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
      const wled = ddpConflict(proposed, getProfile);
      if (wled) return res.status(400).json({ ok: false, error: wled });

      if (countUniverses(proposed) > MAX_UNIVERSES) {
        return res.status(400).json({
          ok: false,
          error: `Universe ${restored.universe} would put the patch on more than the ${MAX_UNIVERSES} `
            + 'universes this server transmits',
        });
      }

      if (restored.id === undefined) restored.id = allocateFixtureId();
      state.nextFixtureId = Math.max(state.nextFixtureId, restored.id + 1);
      state.fixtures.splice(at, 0, restored as typeof restored & { id: number });
      placeAddresslessFixtures();
      resizeFixtureBuffers();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, id: restored.id });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // The show file: the patch as a portable document. The server saves it for
  // the operator on every change (see show-store.js), so this is for moving a
  // rig between machines or keeping a copy, not for not losing your work.
  app.get('/api/show', (_req, res) => res.json(snapshotShow()));

  app.post('/api/show', asyncHandler(async (req, res) => {
    try {
      const result = await showStore.commit(req.body);
      integrations.broadcast();
      res.status(result.applied ? 200 : 503).json({ ok: result.applied, ...result });
    } catch (err) { res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) }); }
  }));
}

function hueProfileBlocked(profile: Profile): string | null {
    return isHueProfile(profile) || isHueProfile(listProfiles()[profile.id]) ? HUE_BY_HAND : null;
}

// What an answer says of the ledmap a WLED has loaded: its size, and why it gives no cells when it does not fit.
function ledmapAnswer(ledmap: WledLedmap | null, info: WledInfo): { width: number; height: number; unused?: string } | null {
  if (!ledmap) return null;
  const unused = ledmapUnused(ledmap, info);
  return { width: ledmap.width, height: ledmap.height, ...(unused ? { unused } : {}) };
}

type GridSize = { columns: number; rows: number } | null;

// A profile's grid as a refresh answers and confirms it: columns and rows, null for a strip.
function gridSize(profile: Profile): GridSize {
  return profile.grid ? { columns: profile.grid.columns, rows: profile.grid.rows } : null;
}

function sameSize(a: GridSize, b: GridSize): boolean {
  return a === null || b === null ? a === b : a.columns === b.columns && a.rows === b.rows;
}

const cellsOn = (count: number, size: GridSize) => `${count} ${count === 1 ? 'cell' : 'cells'}${size ? ` on ${size.columns} × ${size.rows}` : ''}`;

// Every place of its grid holds a cell: what a pixel feed sized to the grid can drive (pixel-input.ts).
function isFullGrid(profile: Profile): boolean {
  return !!profile.grid && !profile.zoned && unitCount(profile) === profile.grid.columns * profile.grid.rows;
}

// Only a patch pixel by pixel takes its cells from the ledmap; zones and strobe panels spread over every LED.
async function ledmapFor(wled: WledClient, host: string, info: WledInfo, look: WledLook): Promise<WledLedmap | null> {
  return (look.mode ?? DEFAULT_WLED_MODE) === 'pixels' && info.matrix && wled.ledmap ? wled.ledmap(host, info) : null;
}
