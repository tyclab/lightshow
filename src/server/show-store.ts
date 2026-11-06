import { state, universeOf, maxBrightnessOf, placeAddresslessFixtures } from './state.ts';
import { resizeFixtureBuffers } from './engine.ts';
import { BUILTIN_PROFILE_ID, BUILTIN_PROFILE_IDS, isBuiltinProfile, MAX_FIXTURES, universeOverflow, unitCapOverflow, registerProfile, clearNonBuiltinProfiles, listProfiles } from './profiles.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { INTERNAL_UNIVERSE, hasNoAddress, isHueLamp, universesOf } from '../shared/placement.ts';
import { isHueProfile, hueSections, hueChannels } from '../shared/hue-lamp.ts';
import { geometryUnitIssue } from '../shared/rig.ts';
import { ddpConflict } from './ddp-routes.ts';
import { showSchema, validate } from './validation.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import { settings, defaultHueBridgeId } from './settings.ts';
import type { ShowFile } from './validation.ts';
import type { Fixture, Profile } from '../types/rig.ts';
import { configFile } from './config-dir.ts';
import { AcknowledgementTimeout } from './frame-barrier.ts';

const SAVE_DEBOUNCE_MS = 400;
const APPLY_TIMEOUT_MS = 5000;

function badShow(message: string): HttpError {
  return new HttpError(400, message);
}

function snapshotShow() { return snapshotRig(state.artnet, state.fixtures, state.nextFixtureId, listProfiles()); }

function snapshotRig(artnet: typeof state.artnet, fixtures: readonly Fixture[], nextFixtureId: number, profiles: Record<string, Profile>) {
  return {
    artnet: { ...artnet },
    nextFixtureId,
    profiles: Object.values(profiles).filter((p) => !isBuiltinProfile(p.id)),
    fixtures: fixtures.map((f) => ({
      id: f.id,
      label: f.label,
      ...(hasNoAddress(f) ? {} : { address: f.address, universe: universeOf(f) }),
      profileId: f.profileId,
      productId: f.productId, hardware: f.hardware, admission: f.admission,
      maxBrightness: maxBrightnessOf(f),
      position: f.position ? { ...f.position } : null,
      group: f.group || null,
      geometry: f.geometry ? { ...f.geometry } : null,
      emission: f.emission ? { ...f.emission } : null,
      output: f.output ? { ...f.output } : null,
    })),
  };
}

interface PreparedRig {
  show: ShowFile;
  artnet: typeof state.artnet;
  fixtures: Fixture[];
  profiles: Record<string, Profile>;
  nextFixtureId: number;
}

function prepareShow(rawShow: unknown): PreparedRig {
  const show = validate(showSchema, rawShow, 'show');
  const explicitFixtures = show.fixtures !== undefined;
  const fixtures = show.fixtures ?? snapshotShow().fixtures.map(f => ({ ...f,
    ...(show.artnet?.universe !== undefined && f.universe === state.artnet.universe ? { universe: show.artnet.universe } : {}),
  }));
  const hasFixtures = true;
  if (hasFixtures && fixtures.length > MAX_FIXTURES) {
    throw badShow(`Show has ${fixtures.length} fixtures, more than the ${MAX_FIXTURES} supported`);
  }

  const incoming: Record<string, Profile> = Object.create(null);
  for (const id of BUILTIN_PROFILE_IDS) incoming[id] = listProfiles()[id];
  if (show.profiles === undefined) Object.assign(incoming, listProfiles());
  if (Array.isArray(show.profiles)) {
    if (new Set(show.profiles.map(p => p.id)).size !== show.profiles.length) throw badShow('Show contains duplicate profile ids');
    for (const p of show.profiles) if (p && p.id && !isBuiltinProfile(p.id)) incoming[p.id] = p;
  }

  const showUniverse = (show.artnet && show.artnet.universe !== undefined)
    ? show.artnet.universe : state.artnet.universe;

  let next: Fixture[] | null = null;
  if (hasFixtures) {
    const ids = fixtures.map((fixture, i) => fixture.id ?? i);
    if (new Set(ids).size !== ids.length) throw badShow('Show contains duplicate fixture ids');
    const fallback = defaultHueBridgeId(settings.group('hue').bridges);
    for (const fixture of fixtures) if (fixture.profileId !== undefined && !incoming[fixture.profileId]) throw badShow(`Unknown profile: ${fixture.profileId}`);
    next = fixtures.map((f, i): Fixture => ({
      id: ids[i],
      label: f.label || `Fixture ${i + 1}`,
      address: f.address || 1,
      universe: f.universe !== undefined ? f.universe : showUniverse,
      profileId: f.profileId !== undefined && incoming[f.profileId] ? f.profileId : BUILTIN_PROFILE_ID,
      maxBrightness: f.maxBrightness !== undefined ? f.maxBrightness : 255,
      position: f.position ? { ...f.position } : null,
      group: f.group || null,
      geometry: f.geometry ? { ...f.geometry } : null,
      emission: f.emission ? { ...f.emission } : null,
      output: !f.output ? null
        : f.output.protocol === 'hue' ? { protocol: 'hue', channels: [...hueChannels(f.output)], bridge: f.output.bridge || fallback } : { ...f.output },
      productId: f.productId, hardware: f.hardware, admission: f.admission,
      override: explicitFixtures ? null : state.fixtures[i]?.override ?? null,
    }));
    const mixed = next.find((f) => isHueLamp(f) !== isHueProfile(incoming[f.profileId]));
    if (mixed) {
      throw badShow(`"${mixed.label}" ${isHueLamp(mixed) ? 'is a Hue lamp on a profile that is not one' : 'is on a Hue lamp profile but not a Hue lamp'}`);
    }
    const channels = new Map<string, string>();
    for (const fix of next) {
      const mapIssue = geometryUnitIssue(fix.geometry, incoming[fix.profileId]);
      if (mapIssue) throw badShow(`"${fix.label}": ${mapIssue}`);
      if (fix.output?.protocol !== 'hue') continue;
      const lampChannels = hueChannels(fix.output);
      if (lampChannels.length !== hueSections(incoming[fix.profileId])) throw badShow(`"${fix.label}" channels do not match its profile sections`);
      for (const channel of lampChannels) {
        const key = `${fix.output.bridge}:${channel}`;
        const other = channels.get(key);
        if (other) throw badShow(`"${fix.label}" and "${other}" are both Hue channel ${channel} of bridge ${fix.output.bridge}`);
        channels.set(key, fix.label);
      }
    }
    placeAddresslessFixtures(next, (fix) => incoming[fix.profileId]);
    for (const fix of next) {
      const overflow = hasNoAddress(fix)
        ? universeOverflow(fix.label, 1, incoming[fix.profileId], INTERNAL_UNIVERSE)
        : universeOverflow(fix.label, fix.address, incoming[fix.profileId], fix.universe);
      if (overflow) throw badShow(overflow);
    }
    const tooMany = unitCapOverflow(next, (fix) => incoming[fix.profileId]);
    if (tooMany) throw badShow(tooMany);
    const wled = ddpConflict(next, (fix) => incoming[fix.profileId] as Profile);
    if (wled) throw badShow(wled);
    const spanned = new Set([showUniverse, ...next.flatMap((f) => universesOf(f.universe as number, incoming[f.profileId]))]);
    if (spanned.size > MAX_UNIVERSES) {
      throw badShow(`Show spans ${spanned.size} universes, more than the ${MAX_UNIVERSES} this server transmits`);
    }
  }

  const prepared = next as Fixture[];
  const highest = prepared.reduce((max, fixture) => Math.max(max, fixture.id), -1);
  return { show, artnet: { ...state.artnet, ...show.artnet }, fixtures: prepared, profiles: incoming,
    nextFixtureId: Math.max(state.nextFixtureId, show.nextFixtureId || 0, highest + 1) };
}

function publishRig(rig: PreparedRig): void {
  clearNonBuiltinProfiles();
  for (const profile of Object.values(rig.profiles)) if (!isBuiltinProfile(profile.id)) registerProfile(profile);
  Object.assign(state.artnet, rig.artnet);
  state.fixtures = rig.fixtures;
  state.nextFixtureId = rig.nextFixtureId;
  resizeFixtureBuffers();
}

function applyShow(rawShow: unknown): ShowFile {
  const rig = prepareShow(rawShow);
  publishRig(rig);
  return rig.show;
}

export interface RigCommitResult {
  saved: true;
  revision: number;
  applied: boolean;
  error?: string;
  superseded?: boolean;
}

class ShowStore extends JsonStore {
  declare _debounceMs: number;
  declare _timer: ReturnType<typeof setTimeout> | null;
  declare _saved: string | null;
  private revision = 0;
  private appliedRevision = 0;
  private applyError: string | null = null;
  private unsupported: Error | null = null;
  private versioned = false;
  private onRigPublished: ((revision: number) => Promise<void>) | null = null;
  routingConflict: { settings: typeof state.artnet; show: typeof state.artnet } | null = null;

  constructor(file: string, { debounceMs = SAVE_DEBOUNCE_MS } = {}) {
    super(file, { tag: 'show', fallback: 'starting on the default patch' });
    this._debounceMs = debounceMs;
    this._timer = null;
    this._saved = null;
  }

  load(): unknown {
    const document = this.readJson() ?? null;
    if (document && typeof document === 'object' && 'formatVersion' in document) {
      const file = document as { formatVersion: unknown; revision?: unknown; show?: unknown };
      if (file.formatVersion !== 1) {
        this.unsupported = new Error(`Unsupported rig format ${String(file.formatVersion)}; the file was left intact`);
        throw this.unsupported;
      }
      if (!Number.isSafeInteger(file.revision) || Number(file.revision) < 0) throw new Error('Invalid saved rig revision');
      this.revision = Number(file.revision);
      this.versioned = true;
      return file.show;
    }
    return document;
  }

  restore(): boolean {
    const show = this.load();
    if (!show) {
      const rig = prepareShow({ artnet: settings.legacyArtnet ?? state.artnet });
      this.revision = 1;
      this.write(this.serialise(snapshotRig(rig.artnet, rig.fixtures, rig.nextFixtureId, rig.profiles)));
      publishRig(rig);
      settings.setArtnetSource(() => ({ ...state.artnet }));
      this._saved = this._serialise();
      return false;
    }
    let rig: PreparedRig;
    try { rig = prepareShow(show); }
    catch (err) {
      this.quarantine(`does not fit this rig (${messageOf(err)})`);
      return false;
    }
    const oldRoute = settings.legacyArtnet;
    // A versioned rig is authoritative. Legacy conflicts need an explicit choice.
    if (!this.versioned && oldRoute && (show as ShowFile).artnet
      && Object.keys(oldRoute).some(key => oldRoute[key as keyof typeof oldRoute] !== rig.artnet[key as keyof typeof oldRoute])) {
      this.routingConflict = { settings: { ...oldRoute }, show: { ...rig.artnet } };
    }
    if (!(show as ShowFile).artnet && oldRoute) rig.artnet = { ...oldRoute };
    if (!this.versioned && !this.routingConflict) {
      this.backupBefore(1);
      this.revision = 1;
      this.write(this.serialise(snapshotRig(rig.artnet, rig.fixtures, rig.nextFixtureId, rig.profiles)));
      this.versioned = true;
    }
    publishRig(rig);
    settings.setArtnetSource(() => ({ ...state.artnet }), { preserveLegacyArtnet: !!this.routingConflict });
    this._saved = this._serialise();
    return true;
  }

  setPublisher(publish: (revision: number) => Promise<void>): void { this.onRigPublished = publish; }

  status() {
    return { revision: this.revision, appliedRevision: this.appliedRevision,
      pending: this.appliedRevision !== this.revision, error: this.applyError, routingConflict: this.routingConflict };
  }

  commit(raw: unknown): Promise<RigCommitResult> {
    if (this.unsupported) throw this.unsupported;
    const rig = prepareShow(raw);
    const revision = this.revision + 1;
    const body = this.serialise(snapshotRig(rig.artnet, rig.fixtures, rig.nextFixtureId, rig.profiles), revision);
    if (!this.versioned) this.backupBefore(1);
    this.write(body);
    this.versioned = true;
    // No asynchronous boundary occurs between persistence and publication.
    publishRig(rig);
    this.revision = revision;
    this._saved = body;
    this.applyError = null;
    this.routingConflict = null;
    settings.setArtnetSource(() => ({ ...state.artnet }));
    return this.applyCurrent();
  }

  applyCurrent(): Promise<RigCommitResult> {
    if (this.unsupported) throw this.unsupported;
    const revision = this.revision;
    let applied: Promise<void>;
    try { applied = this.onRigPublished ? this.onRigPublished(revision) : Promise.reject(new Error('Renderer acknowledgement is not connected')); }
    catch (err) { applied = Promise.reject(err); }
    const bounded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Rig saved; renderer acknowledgement timed out')), APPLY_TIMEOUT_MS);
      timer.unref?.();
      void applied.then(() => { clearTimeout(timer); resolve(); }, err => { clearTimeout(timer); reject(err); });
    });
    return bounded.then(() => {
      if (this.revision !== revision) return { saved: true, revision, applied: false, superseded: true,
        error: 'A newer rig revision replaced this request before acknowledgement' };
      this.appliedRevision = Math.max(this.appliedRevision, revision);
      this.applyError = null;
      return { saved: true, revision, applied: true };
    }, err => {
      const error = messageOf(err);
      if (this.revision === revision) this.applyError = error;
      // Arming waits on a clean rig status, so a late acknowledgement must clear the error it left.
      if (err instanceof AcknowledgementTimeout) err.applied.then(() => {
        if (this.revision !== revision) return;
        this.appliedRevision = Math.max(this.appliedRevision, revision);
        this.applyError = null;
      }, () => { /* the renderer was lost first: the error stands */ });
      return { saved: true, revision, applied: false, error };
    });
  }

  commitArtnet(patch: unknown): Promise<RigCommitResult> { return this.commit({ artnet: patch }); }

  resolveRouting(source: 'settings' | 'show'): Promise<RigCommitResult> {
    if (!this.routingConflict) throw new HttpError(409, 'No routing conflict remains');
    // Conflict resolution chooses the default for new fixtures; imported fixture
    // universe assignments remain explicit and do not move with that default.
    return this.commit({ ...snapshotShow(), artnet: this.routingConflict[source] });
  }

  private serialise(show: ReturnType<typeof snapshotShow>, revision = this.revision): string {
    return `${JSON.stringify({ formatVersion: 1, revision, show }, null, 2)}\n`;
  }

  _serialise(): string { return this.serialise(snapshotShow()); }

  scheduleSave(): void {
    this.revision++;
    this.applyError = null;
    // Mapping mutations are synchronous. Install the sender barrier immediately,
    // including edits arriving while the existing disk debounce is still pending.
    void this.applyCurrent();
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, this._debounceMs);
    // A pending save must not hold the process open; shutdown flushes it.
    if (this._timer.unref) this._timer.unref();
  }

  save(): boolean {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this.unsupported) throw this.unsupported;
    if (this.routingConflict) return false;
    const body = this._serialise();
    if (body === this._saved) return false;
    try {
      if (!this.versioned) this.backupBefore(1);
      this.write(body);
      this.versioned = true;
      this._saved = body;
      return true;
    } catch (err) {
      console.warn(`[show] could not save the patch to ${this.file}: ${messageOf(err)}`);
      return false;
    }
  }
}

const SHOW_FILE = configFile('show.json');
const showStore = new ShowStore(SHOW_FILE);

export {
  showStore,
  ShowStore,
  SHOW_FILE,
  snapshotShow,
  applyShow,
  prepareShow,
};
