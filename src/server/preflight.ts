import { hardwareOf } from '../shared/hardware.ts';

import { state, universeOf, wireUniverses, countUniverses } from './state.ts';
import { hueChannels } from '../shared/hue-lamp.ts';
import { getProfile } from './profiles.ts';
import { fitIssue, footprintOf, overlaps, hasNoAddress, isWled } from '../shared/placement.ts';
import { ddpRoutes } from './ddp-routes.ts';
import { openrgbRoutes } from './openrgb-routes.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { settings } from './settings.ts';
import type { Settings } from './settings.ts';
import { discoverNodes, probeSend } from './artnet.ts';
import { interfaces } from './artnet-nodes.ts';
import * as output from './output.ts';
import { isArmed } from './armed.ts';
import { engineStatus } from './engine.ts';
import { MIN_UNIVERSE, MAX_UNIVERSE } from './sacn.ts';
import { listEntertainmentConfigs } from './hue.ts';
import { wledClient } from './wled.ts';
import { runsOf, pixelWidth } from './ddp-routes.ts';
import { OPENRGB_PORT, matchSameName, openrgbClient } from './openrgb.ts';
import { openrgbOutputOf } from './openrgb-routes.ts';
import { unitCount } from '../shared/rig.ts';
import type { WledClient } from './wled.ts';
import type { OpenRgbClient } from './openrgb.ts';
import type { DdpOutput, Fixture } from '../types/rig.ts';
import { cues } from './cues.ts';
import { midiMap } from './midi-map.ts';
import * as pythonEnv from '../python-env.ts';
import { messageOf } from '../errors.ts';
import { listLiveDevices, findLiveDevice } from '../live-input.ts';
import type { LiveDevices } from '../live-input.ts';
import type { EngineStatus } from './engine.ts';
import { isLoopback } from './loopback.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

/** One row of the pre-show report. */
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string | null;
  /** The Art-Net check lists the nodes that answered. */
  nodes?: unknown[];
}

export interface PreflightReport {
  ok: boolean;
  counts: Record<CheckStatus, number>;
  checks: Check[];
  at: string;
}

/** The live subsystems the checks read, when there are any (none from the CLI). */
export interface PreflightSubjects {
  midi?: { enabled: boolean; listPorts(): { inputs: string[] } } | null;
  standalone?: boolean;
}


/**
 * The check you run before doors open.
 *
 * Every piece of this stack degrades quietly by design: Art-Net send failures
 * are logged and the render loop carries on, and a Python without the live
 * input's packages only surfaces when the input is turned on. Individually that is the right
 * behaviour — none of it should take the show down mid-set. Collectively it
 * means the first sign of a broken rig is the rig not working, in front of an
 * audience.
 *
 * So: one command that asks every one of those questions up front, while there
 * is still time to fix the answer.
 *
 * Statuses:
 *   ok    working
 *   warn  works, but degraded — or we could not prove it either way
 *   fail  will not work; fix before the show
 *   info  nothing to verify, just worth seeing
 */

const OK: CheckStatus = 'ok';
const WARN: CheckStatus = 'warn';
const FAIL: CheckStatus = 'fail';
const INFO: CheckStatus = 'info';

// ── Individual checks ───────────────────────────────────────────────────────

/** What the Art-Net check sends and listens with; the tests hand in stand-ins. */
interface ArtnetProbes {
  probe?: typeof probeSend;
  discover?: typeof discoverNodes;
  discovery?: Pick<typeof output.artnetDiscovery, 'active' | 'pollNow' | 'status'>;
}

/**
 * What leaves as Art-Net: the wire universes no DDP or OpenRGB route carries
 * (transmit.ts sends those to their device instead), and the fixtures on them.
 * A rig of Hue lamps, WLED strips and PC devices has none, whatever the
 * default universe is set to.
 */
function artnetLoad(): { universes: number[]; fixtures: Fixture[] } {
  const own = new Set<number>();
  for (const route of [...ddpRoutes(state.fixtures, getProfile, universeOf), ...openrgbRoutes(state.fixtures, getProfile, universeOf)]) {
    for (const part of route.parts) own.add(part.universe);
  }
  const universes = wireUniverses().filter((u) => !own.has(u));
  const fixtures = state.fixtures.filter((f) => !hasNoAddress(f)
    && footprintOf(universeOf(f), f.address, getProfile(f)).some((part) => universes.includes(part.universe)));
  return { universes, fixtures };
}

async function checkArtnet({ probe = probeSend, discover = discoverNodes, discovery = output.artnetDiscovery }: ArtnetProbes = {}): Promise<Check> {
  if (state.artnet.enabled === false) {
    return {
      id: 'artnet', label: 'Art-Net output', status: INFO,
      detail: 'Disabled. Frames go out over sACN only.',
    };
  }

  const target = { host: state.artnet.host, port: state.artnet.port, universe: state.artnet.universe };
  const load = artnetLoad();
  if (!load.fixtures.length) {
    // Nothing on the rig listens for Art-Net, so no node answering is no news.
    const by = (protocol: string) => state.fixtures.filter((f) => f.output?.protocol === protocol).length;
    const carried = [[by('hue'), 'Hue'], [by('ddp'), 'DDP'], [by('openrgb'), 'OpenRGB']] as const;
    const ways = carried.filter(([n]) => n > 0).map(([n, way]) => `${n} on ${way}`).join(', ');
    const u = load.universes;
    const leaving = u.length
      ? `Only ${u.length === 1 ? 'universe' : 'universes'} ${u.join(', ')}, with no fixture on ${u.length === 1 ? 'it' : 'them'}, `
        + `${u.length === 1 ? 'goes' : 'go'} to ${target.host}:${target.port}.`
      : `No universe goes to ${target.host}:${target.port}.`;
    return {
      id: 'artnet', label: 'Art-Net output', status: INFO,
      detail: `Nothing to check: ${ways ? `every fixture goes to its own device (${ways})` : 'no fixture is patched'}. ${leaving}`,
    };
  }
  const send = await probe(target);
  if (!send.ok) {
    return {
      id: 'artnet', label: 'Art-Net output', status: FAIL,
      detail: `Cannot send to ${target.host}:${target.port} — ${send.error}`,
      fix: 'Check the node IP in Rig → Outputs → Art-Net, and that this machine is on the lighting network.',
    };
  }

  // While the server keeps the node list itself, it holds the Art-Net port:
  // ask it for a fresh poll rather than binding the port a second time.
  let nodes;
  let error;
  if (discovery.active) {
    discovery.pollNow();
    await new Promise((r) => setTimeout(r, 1500));
    ({ nodes, error } = discovery.status());
  } else {
    ({ nodes, error } = await discover({ host: target.host, port: target.port }));
  }
  if (error) {
    return {
      id: 'artnet', label: 'Art-Net output', status: WARN,
      detail: `Sending to ${target.host}:${target.port} works, but could not listen for replies — ${error}`,
      fix: 'Usually another lighting tool already holds UDP 6454. Frames still go out; discovery is the only thing affected.',
    };
  }
  if (!nodes.length) {
    // Plenty of nodes never implement ArtPoll, and a broadcast rig works fine
    // without ever answering one. Silence is not proof of a problem.
    return {
      id: 'artnet', label: 'Art-Net output', status: WARN,
      detail: `Sending to ${target.host}:${target.port}, but no node answered a poll.`,
      fix: 'Many nodes never reply to ArtPoll, so this can be normal. If the rig is dark, check the node IP and the subnet.',
    };
  }
  return {
    id: 'artnet', label: 'Art-Net output', status: OK,
    detail: `${nodes.length} node${nodes.length === 1 ? '' : 's'} answered: `
      + nodes.map((n) => `${n.shortName || n.longName || 'unnamed'} at ${n.from} (${
        n.outputs && n.outputs.length > 1 ? `universes ${n.outputs.join(', ')}` : `universe ${n.universe}`})`).join(', ')
      + (discovery.active ? ' — each is sent its universes directly.' : ''),
    nodes,
  };
}

/**
 * The engine: is it rendering, where, and have its frames been going out on
 * time? A frame half a period late is visibly off the beat grid, and on the
 * main thread that is what a busy server does to the rig — which is why the
 * engine has a thread of its own, and why this says so when it has not.
 */
function checkEngine(status: EngineStatus = engineStatus(), { standalone = false } = {}): Check {
  const label = 'Engine';
  if (!status.thread) {
    // `npm run preflight` runs on its own, before the server is started: there
    // is no engine in that process to report on.
    if (standalone) {
      return { id: 'engine', label, status: INFO, detail: 'Checked on its own — start the server to see how its frames are going.' };
    }
    return { id: 'engine', label, status: FAIL, detail: 'Not rendering.', fix: 'Restart the server.' };
  }
  const where = status.thread === 'worker' ? 'on its own thread' : 'on the main thread';
  const timing = status.frames && status.renderMs && status.lateMs
    ? ` ${status.rate} frames a second; ${status.renderMs.p95} ms to render a frame (p95), `
      + `${status.lateMs.p95} ms late at most on 19 frames of 20.`
    : '';
  const late = (status.lateFrames || 0) + (status.skippedFramesLastMinute || 0);
  // A dropped frame is worth a warning; a frame that went out a little late
  // now and then (a laptop waking a core, a garbage collection) is not, until
  // it is one in a hundred.
  const worrying = (status.skippedFramesLastMinute || 0) > 0
    || (status.lateFrames || 0) > Math.max(2, 0.01 * (status.frames || 0));

  if (status.fellBack) {
    return {
      id: 'engine', label, status: WARN,
      detail: `Rendering ${where}, because ${status.fellBack}.${timing}`,
      fix: 'The rig still runs, but a busy server can now delay it. Restart the server; if this keeps '
        + 'happening, note the error the log shows for the engine thread.',
    };
  }
  if (worrying) {
    return {
      id: 'engine', label, status: WARN,
      detail: `Rendering ${where}, but ${late} frame${late === 1 ? '' : 's'} went out late or not at all `
        + `in the last minute.${timing}`,
      fix: status.thread === 'worker'
        ? 'The machine itself is short of time: close other heavy programs, or plug a laptop in.'
        : 'Set Settings → System → Engine → Render On to its own thread and restart.',
    };
  }
  const note = late ? ` ${late} frame${late === 1 ? '' : 's'} a little late in the last minute.` : '';
  return { id: 'engine', label, status: OK, detail: `Rendering ${where}.${timing}${note}` };
}

/**
 * Whether anything leaves the machine (armed.ts). Disarmed is how the server
 * spends its days, so it is a warning here rather than a failure: worth
 * seeing before doors open, and one press to put right.
 */
function checkOutputsArmed(armed: boolean = isArmed(), { standalone = false } = {}): Check {
  const label = 'Outputs armed';
  if (standalone) {
    return { id: 'armed', label, status: INFO, detail: 'Checked on its own — the running server says whether its outputs are armed.' };
  }
  if (!armed) {
    return {
      id: 'armed', label, status: WARN,
      detail: 'Outputs disarmed: the show renders, but nothing goes out to the rig.',
      fix: 'Arm the outputs before doors open: Arm in the header, or POST /api/control with the action arm.',
    };
  }
  return { id: 'armed', label, status: OK, detail: 'Armed: frames go out to the rig.' };
}

function checkSacn(): Check {
  const config = output.getSacnConfig();
  if (!config.enabled) {
    return {
      id: 'sacn', label: 'sACN output', status: INFO,
      detail: 'Disabled. Turn it on in Rig → Outputs → sACN (E1.31) if your console speaks it.',
    };
  }

  const mapped = wireUniverses().map((u) => [u, output.sacnUniverseFor(u)]);
  const unmappable = mapped.filter(([, to]) => to === null).map(([from]) => from);
  if (unmappable.length) {
    return {
      id: 'sacn', label: 'sACN output', status: FAIL,
      detail: `Universe ${unmappable.join(', ')} maps outside the ${MIN_UNIVERSE}–${MAX_UNIVERSE} sACN range `
        + `at offset ${config.universeOffset}, so ${unmappable.length === 1 ? 'it' : 'they'} will not be sent.`,
      fix: 'Change the universe offset in Rig → Outputs → sACN (E1.31), or move those fixtures.',
    };
  }

  if (config.interface && !interfaces().some((i) => i.address === config.interface)) {
    return {
      id: 'sacn', label: 'sACN output', status: FAIL,
      detail: `Multicast is set to leave from ${config.interface}, which is not an address of this machine.`,
      fix: 'Pick the show network under Rig → Outputs → sACN (E1.31) → Network, or let the computer choose.',
    };
  }

  const where = config.host
    ? `unicast to ${config.host}`
    : `multicast${config.interface ? ` from ${config.interface}` : ''}`;
  return {
    id: 'sacn', label: 'sACN output', status: OK,
    detail: `${where}, priority ${config.priority}, as "${config.sourceName}". `
      + `Universes ${mapped.map(([from, to]) => `${from}→${to}`).join(', ')}.`,
  };
}

/**
 * The WLEDs in the patch: does each answer, and is it still the length it was
 * patched as? A WLED re-set to fewer LEDs takes the pixels past its end
 * nowhere; one given more leaves them to its own effects. Another DDP
 * receiver has no API to ask, so it is left out.
 */
async function checkWled(client: Pick<WledClient, 'info'> = wledClient): Promise<Check> {
  const wleds = state.fixtures.filter(isWled);
  if (!wleds.length) {
    return { id: 'wled', label: 'WLED', status: INFO, detail: 'None in the patch. Add one under Rig → Outputs → WLED.' };
  }
  const answers = await Promise.all(wleds.map(async (fix) => {
    const output = fix.output as DdpOutput;
    const host = output.host;
    const profile = getProfile(fix);
    // A segment has to fit in the WLED; all of it has to be all of it — its
    // LEDs, which a wash or zones light a few cells across.
    const segment = output.at !== undefined;
    const patched = segment
      ? Math.max(...runsOf(output, profile, pixelWidth(profile) || profile.channelCount).map((run) => run.at + run.count))
      : output.leds ?? unitCount(profile);
    try {
      const info = await client.info(host);
      return { fix, host, patched, segment, leds: info.leds, error: null };
    } catch (err) {
      return { fix, host, patched, segment, leds: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  const silent = answers.filter((a) => a.error);
  const resized = answers.filter((a) => !a.error && (a.segment ? a.leds < a.patched : a.leds !== a.patched));
  if (silent.length) {
    return {
      id: 'wled', label: 'WLED', status: FAIL,
      detail: silent.map((a) => `"${a.fix.label}" at ${a.host} does not answer (${a.error})`).join('; '),
      fix: 'Check it is powered and on this network, or correct its address in Rig → Plan & patch.',
    };
  }
  if (resized.length) {
    return {
      id: 'wled', label: 'WLED', status: WARN,
      detail: resized.map((a) => (a.segment
        ? `"${a.fix.label}" reaches LED ${a.patched}, but its WLED reports ${a.leds}`
        : `"${a.fix.label}" reports ${a.leds} LEDs but is patched as ${a.patched}`)).join('; '),
      fix: 'Remove it from the patch and add it again under Rig → Outputs → WLED.',
    };
  }
  return {
    id: 'wled', label: 'WLED', status: OK,
    detail: answers.map((a) => `"${a.fix.label}" at ${a.host}, ${a.leds} LEDs`).join('; ') + ', sent over DDP.',
  };
}

/**
 * The OpenRGB devices in the patch: does each server answer, does it still
 * list each device, and is the device still the length it was patched as? A
 * PC that is off is a warning, not a failure: the rest of the show goes on
 * without its RGB.
 */
async function checkOpenRgb(client: Pick<OpenRgbClient, 'discover'> = openrgbClient): Promise<Check> {
  const fixtures = state.fixtures.filter((f) => openrgbOutputOf(f));
  if (!fixtures.length) {
    return { id: 'openrgb', label: 'OpenRGB', status: INFO, detail: 'None in the patch. Add a PC\'s devices under Rig → Outputs → OpenRGB.' };
  }
  const servers = new Map<string, { host: string; port: number; fixtures: typeof fixtures }>();
  for (const fix of fixtures) {
    const output = openrgbOutputOf(fix) as NonNullable<ReturnType<typeof openrgbOutputOf>>;
    const port = output.port ?? OPENRGB_PORT;
    const key = `${output.host.toLowerCase()}:${port}`;
    const entry = servers.get(key) || { host: output.host, port, fixtures: [] };
    entry.fixtures.push(fix);
    servers.set(key, entry);
  }
  const where = (s: { host: string; port: number }) => (s.port === OPENRGB_PORT ? s.host : `${s.host}:${s.port}`);
  const silent: string[] = [];
  const wrong: string[] = [];
  const fine: string[] = [];
  await Promise.all([...servers.values()].map(async (server) => {
    const names = server.fixtures.map((f) => `"${f.label}"`).join(', ');
    let devices;
    try {
      devices = await client.discover(server.host, server.port);
    } catch (err) {
      silent.push(`OpenRGB at ${where(server)} does not answer (${messageOf(err)}); on it: ${names}`);
      return;
    }
    const outputs = server.fixtures.map((fix) => ({ fix, output: openrgbOutputOf(fix) as NonNullable<ReturnType<typeof openrgbOutputOf>> }));
    for (const { fix, output } of outputs) {
      // A device patched under a name is the one of its name at its
      // location, else in order, as the transmitter finds it (openrgb.ts
      // resolve); one patched by number alone is that number.
      let device = output.name ? undefined : devices.find((d) => d.index === output.device);
      let moved = '';
      if (output.name) {
        const named = devices.filter((d) => d.name === output.name);
        const siblings = outputs.filter((o) => o.output.name === output.name).map((o) => o.output).sort((a, b) => a.device - b.device);
        const index = matchSameName(siblings.map((o) => o.location), named)[siblings.indexOf(output)];
        device = named.find((d) => d.index === index);
        if (!device) {
          wrong.push(`"${fix.label}" (${output.name}, #${output.device}) is not among the ${devices.length} devices at ${where(server)}`);
          continue;
        }
        if (device.index !== output.device) moved = ` (was #${output.device})`;
      } else if (!device) {
        wrong.push(`"${fix.label}" is device #${output.device} at ${where(server)}, which lists only ${devices.length}`);
        continue;
      }
      if (device.leds !== output.leds) wrong.push(`"${fix.label}" (${device.name}) reports ${device.leds} LEDs but is patched as ${output.leds}`);
      else fine.push(`"${fix.label}" at ${where(server)} #${device.index}${moved} ${device.name}, ${device.leds} LEDs`);
    }
  }));
  if (silent.length) {
    return {
      id: 'openrgb', label: 'OpenRGB', status: WARN, detail: silent.join('; '),
      fix: 'Start OpenRGB on that PC with its SDK server on, check the address in the patch, or remove its fixtures from the patch.',
    };
  }
  if (wrong.length) {
    return {
      id: 'openrgb', label: 'OpenRGB', status: WARN, detail: wrong.join('; '),
      fix: 'A device patched under its name is found again by it once OpenRGB lists it (a monitor asleep, a mouse off). '
        + 'One gone for good, or patched by number alone and renumbered: remove the fixture and add the device again under Rig → Outputs → OpenRGB.',
    };
  }
  return { id: 'openrgb', label: 'OpenRGB', status: OK, detail: `${fine.join('; ')}, sent over the OpenRGB SDK.` };
}

/**
 * Philips Hue: is the bridge there, does the area still exist, and is every
 * Hue lamp in the patch one of its channels?
 *
 * The last question is the one worth asking before doors. A lamp is patched
 * as a channel of the area, and an area rebuilt in the Hue app, or another one
 * picked, can leave it naming a channel that is not there — the bridge takes
 * the colour and ignores it, which on the night looks like a dead lamp rather
 * than a configuration mistake.
 */
async function checkHue(): Promise<Check[]> {
  const config = output.getHueConfig();
  const lamps = state.fixtures.filter((f) => f.output?.protocol === 'hue');
  const bridgeOf = (f: (typeof lamps)[number]) => (f.output?.protocol === 'hue' ? f.output.bridge : '');
  if (!config.bridges.length) {
    return [lamps.length ? {
      id: 'hue', label: 'Philips Hue', status: WARN,
      detail: `${lamps.length} Hue lamp${lamps.length === 1 ? ' is' : 's are'} in the patch, but no bridge is paired, so `
        + `${lamps.length === 1 ? 'it stays' : 'they stay'} dark.`,
      fix: 'Pair the bridge in Rig → Outputs → Philips Hue, or remove the lamps from the patch.',
    } : {
      id: 'hue', label: 'Philips Hue', status: INFO,
      detail: 'No bridge paired. Pair one in Rig → Outputs → Philips Hue to drive Hue lamps from the show.',
    }];
  }

  // Every bridge is asked at once: each is its own device on its own address.
  const checks = await Promise.all(config.bridges.map((bridge) => checkHueBridge(bridge, lamps.filter((f) => bridgeOf(f) === bridge.id))));
  const known = new Set(config.bridges.map((b) => b.id));
  const orphans = lamps.filter((f) => !known.has(bridgeOf(f)));
  if (orphans.length) {
    checks.push({
      id: 'hue', label: 'Philips Hue', status: WARN,
      detail: `${orphans.map((f) => `"${f.label}" (bridge ${bridgeOf(f)})`).join(', ')} name${orphans.length === 1 ? 's' : ''} a bridge `
        + `that is not paired, so ${orphans.length === 1 ? 'it stays' : 'they stay'} dark.`,
      fix: 'The bridge was forgotten. Remove those lamps and add them again from the bridge they belong to.',
    });
  }
  return checks;
}

/** One bridge: there, its area still there, every lamp of it one of the area's channels. */
async function checkHueBridge(bridge: Settings['hue']['bridges'][number], lamps: typeof state.fixtures, listAreas = listEntertainmentConfigs): Promise<Check> {
    const id = `hue:${bridge.id}`;
    const name = bridge.label || bridge.id;
    const label = `Philips Hue — ${name}`;
    const channelsOf = (f: (typeof lamps)[number]) => (f.output?.protocol === 'hue' ? hueChannels(f.output) : []);
    if (!bridge.enabled) {
        return lamps.length ? {
            id, label, status: WARN,
            detail: `${lamps.length} lamp${lamps.length === 1 ? ' is' : 's are'} in the patch, but the bridge's output is off, so `
                + `${lamps.length === 1 ? 'it stays' : 'they stay'} dark.`,
            fix: `Turn "${name}" on in Rig → Outputs → Philips Hue, or remove its lamps from the patch.`,
        } : {
            id, label, status: INFO,
            detail: `Off. Turn "${name}" on in Rig → Outputs → Philips Hue to drive its lamps from the show.`,
        };
    }
    const missing = [];
    if (!bridge.host)
        missing.push('bridge address');
    if (!bridge.username || !bridge.clientKey)
        missing.push('pairing');
    if (!bridge.entertainmentId)
        missing.push('entertainment area');
    if (missing.length) {
        return {
            id, label, status: FAIL,
            detail: `"${name}" is on but the ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set up.`,
            fix: 'Open Rig → Outputs → Philips Hue, press the bridge\'s link button to pair, then pick an area.',
        };
    }
    if (!lamps.length) {
        return {
            id, label, status: WARN,
            detail: `Paired with "${name}" at ${bridge.host}, but none of its lamps is in the patch, so nothing of it will light.`,
            fix: 'Add the area\'s lamps in Rig → Outputs → Philips Hue.',
        };
    }
    const seen = new Map<number, string>();
    for (const lamp of lamps) {
        for (const channel of channelsOf(lamp)) {
            const other = seen.get(channel);
            if (other) {
                return {
                    id, label, status: WARN,
                    detail: `"${lamp.label}" and "${other}" are both on channel ${channel} of "${name}"; only "${other}" is shown there.`,
                    fix: 'Remove one of them from the patch.',
                };
            }
            seen.set(channel, lamp.label);
        }
    }
    let areas;
    try {
        areas = await listAreas(bridge.host, bridge.username);
    }
    catch (err) {
        return {
            id, label, status: WARN,
            detail: `Cannot reach "${name}" at ${bridge.host} — ${messageOf(err)}`,
            fix: 'Check the bridge is powered and on this network, and that its IP has not changed.',
        };
    }
    const area = areas.find((a) => a.id === bridge.entertainmentId);
    if (!area) {
        return {
            id, label, status: FAIL,
            detail: `"${name}" at ${bridge.host} has no entertainment area ${bridge.entertainmentId} any more.`,
            fix: 'It was probably renamed or rebuilt in the Hue app. Pick the area again in Rig → Outputs → Philips Hue.',
        };
    }
    const areaChannels = new Set(area.channels.map((c) => c.id));
    const stray = lamps.filter((f) => channelsOf(f).some((ch) => !areaChannels.has(ch)));
    if (stray.length) {
        const absent = (f: (typeof lamps)[number]) => channelsOf(f).filter((ch) => !areaChannels.has(ch)).map((ch) => `#${ch}`).join(', ');
        return {
            id, label, status: WARN,
            detail: `"${area.name}" has no channel ${stray.map((f) => `${absent(f)} for "${f.label}"`).join('; ')}, `
                + `so ${stray.length === 1 ? 'that stays' : 'those stay'} dark.`,
            fix: 'The area was probably changed in the Hue app. Remove those lamps and add them again from Rig → Outputs → Philips Hue.',
        };
    }
    const resectioned = lamps.filter((f) => {
        if (getProfile(f).hue?.legacy || getProfile(f).hue?.partial) return false;
        const channels = channelsOf(f);
        const lamp = area.lamps?.find((l) => l.channels.includes(channels[0]));
        return lamp && (lamp.channels.length !== channels.length || lamp.channels.some((ch, k) => ch !== channels[k]));
    });
    if (resectioned.length) {
        return {
            id, label, status: WARN,
            detail: `${resectioned.map((f) => `"${f.label}"`).join(', ')} ${resectioned.length === 1 ? 'has' : 'have'} different sections `
                + `in "${area.name}" now than when ${resectioned.length === 1 ? 'it was' : 'they were'} patched.`,
            fix: 'Remove those lamps and add them again from Rig → Outputs → Philips Hue.',
        };
    }
    const live = output.getHueStatus().find((s) => s.id === bridge.id);
    if (live?.occupiedBy) {
        return {
            id, label, status: WARN,
            detail: `"${live.occupiedBy.area}" on "${name}" is streaming from another app, so "${area.name}" gets nothing from the show until it stops.`,
            fix: 'Stop that sync (a Sync Box\'s light sync, the Hue app or another controller); the lightshow starts by itself once the area is free.',
        };
    }
    if (live && live.status === 'failed') {
        return {
            id, label, status: WARN,
            detail: `"${area.name}" on "${name}" is set up correctly, but the last stream attempt failed — ${live.error}.`,
            fix: 'A bridge only allows one entertainment stream at a time. Close the Hue app\'s sync or any other tool streaming to it.',
        };
    }
    const left = (area.lamps || []).filter((l) => !l.channels.some((ch) => seen.has(ch))).length;
    return {
        id, label, status: OK,
        detail: `"${area.name}" on "${name}" at ${bridge.host}: ${lamps.map((f) => f.label).join(', ')}`
            + `${left > 0 ? `; ${left} of its lamp${left === 1 ? ' is' : 's are'} not in the patch` : ''}.`,
    };
}

function checkPatch(): Check {
  const problems = [];

  for (const fix of state.fixtures) {
    const issue = fitIssue(fix.label, fix.address, getProfile(fix), universeOf(fix));
    if (issue) problems.push(issue);
  }

  // Two fixtures only fight over an address when they share a universe — a
  // strip running on into the next counts on every universe it covers.
  const footprints = state.fixtures.map((f) => footprintOf(universeOf(f), f.address, getProfile(f)));
  for (let i = 0; i < state.fixtures.length; i++) {
    for (let j = i + 1; j < state.fixtures.length; j++) {
      if (!overlaps(footprints[i], footprints[j])) continue;
      const shared = footprints[i].find((x) => footprints[j].some((y) => y.universe === x.universe))?.universe;
      problems.push(`"${state.fixtures[i].label}" and "${state.fixtures[j].label}" overlap on universe ${shared}`);
    }
  }

  const universes = wireUniverses();
  const devices = state.fixtures.filter(hasNoAddress);
  const spanned = countUniverses(state.fixtures);
  if (spanned > MAX_UNIVERSES) {
    problems.push(`the patch spans ${spanned} universes, more than the ${MAX_UNIVERSES} rendered`);
  }

  if (problems.length) {
    return {
      id: 'patch', label: 'Fixture patch', status: FAIL,
      detail: problems.join('; '),
      fix: 'Fix the addressing in Rig → Plan & patch.',
    };
  }

  return {
    id: 'patch', label: 'Fixture patch', status: OK,
    detail: `${state.fixtures.length - devices.length} fixture${state.fixtures.length - devices.length === 1 ? '' : 's'} `
      + `on universe${universes.length === 1 ? '' : 's'} ${universes.join(', ')}, no overlaps`
      + `${devices.length ? `, and ${deviceCounts(devices)} with no DMX address` : ''}.`,
  };
}

/** The fixtures sent to devices of their own, counted by kind: "2 Hue lamps and 1 WLED". */
function deviceCounts(fixtures: readonly Fixture[]): string {
  const on = (protocol: string) => (f: Fixture) => f.output?.protocol === protocol;
  const kinds: [(f: Fixture) => boolean, string, string][] = [
    [on('hue'), 'Hue lamp', 'Hue lamps'], [isWled, 'WLED', 'WLEDs'],
    [(f) => on('ddp')(f) && !isWled(f), 'DDP device', 'DDP devices'], [on('openrgb'), 'OpenRGB device', 'OpenRGB devices'],
  ];
  const parts = kinds.map(([kind, one, many]) => {
    const n = fixtures.filter(kind).length;
    return n ? `${n} ${n === 1 ? one : many}` : null;
  }).filter((part): part is string => part !== null);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}

function checkPython(): Check {
  const info = pythonEnv.resolve();
  if (!info.ok) {
    return {
      id: 'python', label: 'Python', status: FAIL,
      detail: `"${info.exe}" cannot be run — the live input will not start.`,
      fix: 'Install Python 3 with the packages in requirements.txt, or set a Python\'s full path under Music → Live input → Python.',
    };
  }
  if (info.missing.length) {
    const where = info.executable || info.exe;
    return {
      id: 'python', label: 'Python', status: FAIL,
      detail: `${where} (${info.version}) is missing: ${info.missing.join(', ')}.`,
      fix: `"${where}" -m pip install -r requirements.txt`,
    };
  }
  return {
    id: 'python', label: 'Python', status: OK,
    detail: `${info.executable || info.exe} (${info.version}) — everything the live input needs is present.`,
  };
}

function checkMidi(midi: PreflightSubjects['midi']): Check {
  if (!midi) return { id: 'midi', label: 'MIDI', status: INFO, detail: 'Not available.' };

  const wanted = settings.get('midi.input');
  const { customised } = midiMap.snapshot();
  const mapNote = customised ? 'your saved mapping' : 'the built-in X-Touch mapping';

  if (midi.enabled) {
    return { id: 'midi', label: 'MIDI', status: OK, detail: `Connected, using ${mapNote}.` };
  }

  if (!wanted) {
    return {
      id: 'midi', label: 'MIDI', status: INFO,
      detail: 'No controller configured. The web UI still works.',
    };
  }

  const ports = midi.listPorts();
  const present = ports.inputs.includes(wanted);
  return {
    id: 'midi', label: 'MIDI', status: WARN,
    detail: present
      ? `"${wanted}" is present but not connected.`
      : `"${wanted}" is not among the available inputs (${ports.inputs.join(', ') || 'none'}).`,
    fix: 'Plug the controller in and reconnect it in Settings → MIDI.',
  };
}

/**
 * The live input, when it is on: a capture library the service can import,
 * and the device it is set to among those it finds.
 */
async function checkLiveInput({ list = listLiveDevices }: { list?: () => Promise<LiveDevices> } = {}): Promise<Check> {
  const config = settings.group('live');
  if (!config.enabled) {
    return { id: 'live', label: 'Live input', status: INFO, detail: 'Off. Turn it on in Music → Live input to follow the music by ear.' };
  }
  let devices: LiveDevices;
  try {
    devices = await list();
  } catch (err) {
    return {
      id: 'live', label: 'Live input', status: WARN, detail: messageOf(err),
      fix: 'Check the Python interpreter under Music → Live input, and install requirements.txt into it.',
    };
  }
  if (!devices.backend) {
    return {
      id: 'live', label: 'Live input', status: WARN,
      detail: 'No capture library: the live input cannot hear anything.',
      fix: 'Install it into the live input\'s Python: pip install soundcard',
    };
  }
  const loopback = config.source === 'loopback';
  const listed = loopback ? devices.outputs : devices.inputs;
  const wanted = config.device;
  // The capture opens the device by the backend's id as readily as by its name (live-input.ts).
  const found = wanted ? findLiveDevice(wanted, listed, loopback ? devices.outputIds : devices.inputIds) : null;
  if (wanted && !found) {
    return {
      id: 'live', label: 'Live input', status: WARN,
      detail: `"${wanted}" is not among the ${loopback ? 'outputs' : 'inputs'} (${listed.join(', ') || 'none'}).`,
      fix: 'Plug it in, or pick another in Music → Live input.',
    };
  }
  const which = found ? (found === wanted ? found : `${found} (${wanted})`)
    : (loopback ? devices.defaultOutput : devices.defaultInput) || 'the default device';
  return {
    id: 'live', label: 'Live input', status: OK,
    detail: `${config.source === 'loopback' ? 'Hears what' : 'Listens to'} ${which}${config.source === 'loopback' ? ' plays' : ''} (${devices.backend}).`,
  };
}

function checkAccess(): Check {
  const host = settings.get('server.host');
  const hasToken = !!settings.get('server.token');
  const loopback = isLoopback(host);

  if (loopback) {
    return {
      id: 'access', label: 'Access', status: INFO,
      detail: `Bound to ${host} — reachable from this machine only.`,
    };
  }
  if (!hasToken) {
    // The startup guard already refuses this, so reaching it means a
    // hand-edited config that has not been restarted into yet.
    return {
      id: 'access', label: 'Access', status: FAIL,
      detail: `Bound to ${host} with no access token — anyone on the network could black out the rig.`,
      fix: 'Set one in Settings → System → Server & access → Access Token.',
    };
  }
  return {
    id: 'access', label: 'Access', status: OK,
    detail: `Bound to ${host}, token required.`,
  };
}

function checkCues(): Check {
  const count = cues.summaries().length;
  return {
    id: 'cues', label: 'Cues', status: INFO,
    detail: count ? `${count} saved look${count === 1 ? '' : 's'}.` : 'No cues saved.',
  };
}

/**
 * Run every check.
 *
 * The subsystems come in as arguments rather than being reached for, so this is
 * callable both from the server (which has live ones) and from the CLI (which
 * has none, and reports the checks that do not need them).
 */
async function runPreflight({ midi, standalone = false }:
  PreflightSubjects = {}): Promise<PreflightReport> {
  // The network and live-input probes are independent and each waits on a reply;
  // run them together rather than serially in front of an operator waiting on
  // the report.
  const [artnet, hue, wled, openrgb, live] = await Promise.all([
    checkArtnet(),
    checkHue(),
    checkWled(),
    checkOpenRgb(),
    checkLiveInput(),
  ]);

  const unverified = state.fixtures.filter((f) => !hardwareOf(f, getProfile(f), settings.group('hardware')).measured);
  const constrained = state.fixtures.filter((f) => f.admission === 'hold' || f.admission === 'exclude');
  const checks: Check[] = [
    { id: 'hardware-capability', label: 'Hardware capability', status: unverified.length ? 'warn' : 'ok',
      detail: `${unverified.length} fixtures have limits without measurements verifying the configured rate. ${constrained.length} fixtures hold or exclude effects they cannot follow.`,
      fix: unverified.length ? 'Review Hardware limits in Rig → Outputs and each fixture in Rig → Plan & patch.' : null },
    checkEngine(engineStatus(), { standalone }),
    checkOutputsArmed(isArmed(), { standalone }),
    artnet,
    checkSacn(),
    ...hue,
    wled,
    openrgb,
    checkPatch(),
    checkAccess(),
    checkMidi(midi),
    checkPython(),
    live,
    checkCues(),
  ];

  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const check of checks) counts[check.status]++;

  return { ok: counts.fail === 0, counts, checks, at: new Date().toISOString() };
}

export const STATUSES = { OK, WARN, FAIL, INFO };

export {
  runPreflight,
  checkPatch,
  checkEngine,
  checkOutputsArmed,
  checkArtnet,
  checkLiveInput,
  checkSacn,
  checkHue,
  checkWled,
  checkOpenRgb,
  checkAccess,
  checkMidi,
};
