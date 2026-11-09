import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMirror } from '../state.js';
export function snapshot() {
  return { protocol: 2, versions: { rig: 1, look: 1 }, state: {
    armed: true, clock: { bpm: 120, beatPos: 1, at: 1 }, safety: { photosensitivityAcknowledged: true },
    fixtures: [{ id: 53, profileId: 'panel', output: { protocol: 'ddp', host: 'example.invalid' } }],
    profiles: { panel: { grid: { columns: 2, rows: 1 }, cells: [{ channelMap: { red: 0, green: 1, blue: 2 } }, { channelMap: { red: 3, green: 4, blue: 5 } }] } },
  } };
}
const options = { fixtureId: 53, width: 2, height: 1 };
test('fresh snapshot, armed state, acknowledgement and current complete grid are required', () => {
  let now = 0; const mirror = new StateMirror(() => now);
  assert.equal(mirror.target(options).ok, false);
  mirror.snapshot(snapshot()); assert.equal(mirror.target(options).ok, true);
  now = 1500; assert.equal(mirror.target(options).ok, false);
  for (const edit of [s => { s.state.armed = false; }, s => { s.state.clock = null; }, s => { s.state.safety.photosensitivityAcknowledged = false; }, s => { s.state.profiles.panel.zoned = true; }, s => { s.state.profiles.panel.cells[1].at = { x: 0, y: 0 }; }, s => { delete s.state.profiles.panel.cells[0].channelMap.blue; }, s => { s.state.fixtures[0].output.protocol = 'openrgb'; }]) {
    const value = snapshot(); edit(value); mirror.snapshot(value); assert.equal(mirror.target(options).ok, false);
  }
});
test('patch gaps and reconnect invalidate state; patches alone cannot renew freshness', () => {
  let now = 0; const mirror = new StateMirror(() => now);
  mirror.snapshot(snapshot());
  assert.equal(mirror.patch({ d: 'rig', v: 2, set: { armed: false } }), true);
  assert.equal(mirror.target(options).ok, false);
  assert.equal(mirror.patch({ d: 'rig', v: 4, set: { armed: true } }), false);
  assert.equal(mirror.target(options).ok, false);
  mirror.snapshot(snapshot()); now = 1500;
  mirror.patch({ d: 'look', v: 2, set: { clock: { bpm: 120, beatPos: 2, at: 2 } } });
  assert.equal(mirror.target(options).ok, false);
  mirror.snapshot(snapshot()); assert.equal(mirror.target(options).ok, true);
  mirror.reset(); assert.equal(mirror.target(options).ok, false);
});
test('route changes alter target identity without logging endpoint data', () => {
  const mirror = new StateMirror(); mirror.snapshot(snapshot()); const before = mirror.target(options).key;
  const next = snapshot(); next.state.fixtures[0].output.at = 5; mirror.snapshot(next);
  assert.notEqual(mirror.target(options).key, before);
});
test('effects pauses visualizer targets without changing armed status; older servers still work', () => {
  const mirror = new StateMirror(); mirror.snapshot(snapshot());
  assert.equal(mirror.base().ok, true, 'older servers without a picture selector');
  mirror.patch({ d: 'rig', v: 2, set: { picture: { source: 'effects' } } });
  assert.deepEqual(mirror.base(), { ok: false, reason: 'Visualizer not selected' });
  assert.equal(mirror.target(options).ok, false);
  assert.equal(mirror.armed(), true, 'armed displays stay awake while effects are selected');
  mirror.patch({ d: 'rig', v: 3, set: { picture: { source: 'visualizer' } } });
  assert.equal(mirror.target(options).ok, true);
});
test('armed needs fresh state with armed outputs only, so a missing clock or acknowledgement still keeps the displays awake', () => {
  let now = 0; const mirror = new StateMirror(() => now);
  assert.equal(mirror.armed(), false);
  const bare = snapshot(); bare.state.clock = null; bare.state.safety.photosensitivityAcknowledged = false;
  mirror.snapshot(bare); assert.equal(mirror.armed(), true);
  now = 1499; assert.equal(mirror.armed(), true);
  now = 1500; assert.equal(mirror.armed(), false, 'an unreachable server is not armed');
  mirror.snapshot(snapshot()); assert.equal(mirror.armed(), true);
  mirror.patch({ d: 'rig', v: 2, set: { armed: false } }); assert.equal(mirror.armed(), false);
  mirror.snapshot(snapshot()); mirror.reset(); assert.equal(mirror.armed(), false);
});

test('Colour + motion allows the room feed while panels pause and still requires arm and acknowledgement', () => {
  const mirror = new StateMirror();
  const value = snapshot(); value.state.picture = { source: 'inspired' };
  mirror.snapshot(value);
  assert.equal(mirror.base().ok, true);
  assert.equal(mirror.target(options).ok, false);
  value.state.armed = false; mirror.snapshot(value);
  assert.equal(mirror.base().ok, false);
  value.state.armed = true; value.state.safety.photosensitivityAcknowledged = false; mirror.snapshot(value);
  assert.equal(mirror.base().ok, false);
});
test('a live sync keeps the rig held for the same revision, drops it for another, and replaces it when sent', () => {
  const mirror = new StateMirror(() => 0);
  const at = (revision, withRig = true) => {
    const value = snapshot();
    value.state.rigRevision = revision;
    if (!withRig) { delete value.state.fixtures; delete value.state.profiles; }
    return value;
  };
  assert.equal(mirror.rigRevision(), undefined, 'nothing held: ask for the rig');
  assert.equal(mirror.live(at(7)), true);
  assert.equal(mirror.rigRevision(), 7);
  assert.equal(mirror.live(at(7, false)), true);
  assert.equal(mirror.target(options).ok, true, 'the same revision: the rig held is current');
  assert.equal(mirror.rigRevision(), 7);
  const moved = at(8); moved.state.fixtures[0].output.host = 'moved.invalid';
  mirror.live(moved);
  assert.equal(mirror.rigRevision(), 8);
  assert.equal(JSON.parse(JSON.stringify(mirror.state.fixtures))[0].output.host, 'moved.invalid', 'a moved revision brings its rig');
  mirror.live(at(9, false));
  assert.equal(mirror.target(options).ok, false, 'another revision without its rig: none held');
  assert.equal(mirror.rigRevision(), undefined, 'so the next sync asks for it');
  const older = snapshot();
  mirror.live(older);
  assert.equal(mirror.target(options).ok, true, 'an older server: no revision, the rig every time');
  assert.equal(mirror.rigRevision(), undefined);
  mirror.snapshot(at(10, false));
  assert.equal(mirror.target(options).ok, false, 'a snapshot is the whole state: nothing carried over');
});
