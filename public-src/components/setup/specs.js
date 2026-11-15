/**
 * The stored settings, section by section: what each field is called, what
 * it takes and what it does. Rendered by SettingsSection, so every one gets
 * the same layout, secret handling and restart badge.
 *
 * `ctx` carries the lists some pickers are built from, which live elsewhere:
 * this machine's network interfaces and audio devices, MIDI's output ports,
 * the Hue bridge's entertainment areas.
 */

/** Where the engine is rendering right now, and how its frames have been going. */
export function engineNote(data) {
  const e = data && data.engine;
  if (!e || !e.thread) return null;
  const where = e.thread === 'worker' ? 'its own thread' : 'the main thread';
  const pace = e.idle ? 'idle (disarmed, nothing watching), rendering a few frames a second' : `${e.rate} frames a second`;
  const timing = e.frames
    ? ` — ${pace}, ${e.renderMs.p95} ms to render (p95), `
      + `${(e.lateFrames || 0) + (e.skippedFramesLastMinute || 0)} late or dropped in the last minute`
    : '';
  if (e.fellBack) return { ok: false, text: `Currently: ${where}, because ${e.fellBack}${timing}.` };
  return { ok: true, text: `Currently: ${where}${timing}.` };
}

/**
 * What the server actually resolved, rather than what the box says. "I ran
 * pip install" and "the live input can import numpy" are different claims,
 * and on a machine with several Pythons they are about different interpreters.
 */
export function pythonNote(data) {
  const py = data && data.python;
  if (!py) return null;
  if (!py.ok) return { ok: false, text: `Currently: ${py.exe} — cannot be run.` };
  const where = py.executable || py.exe;
  if (py.missing && py.missing.length) {
    return { ok: false, text: `Currently: ${where} (${py.version}) — missing ${py.missing.join(', ')}. `
      + `Install them with: "${where}" -m pip install -r requirements.txt` };
  }
  return { ok: true, text: `Currently: ${where} (${py.version}) — all dependencies present.` };
}

export const ARTNET = {
  id: 'artnet',
  title: 'Art-Net',
  desc: 'What most small nodes speak. Takes effect immediately.',
  fields: [
    { path: 'artnet.enabled', label: 'Enabled', type: 'toggle', help: 'Turn off to run sACN only.' },
    { path: 'artnet.host', label: 'Node IP', type: 'text',
      help: 'A broadcast address (ending in .255) reaches every node on the subnet; a node\'s own address sends to it alone.' },
    { path: 'artnet.port', label: 'Port', type: 'number', min: 1, max: 65535 },
    { path: 'artnet.universe', label: 'Universe', type: 'number', min: 0, max: 32767,
      help: 'The rig\'s default universe: it seeds new fixtures, and fixtures sitting on it follow when you change it.' },
    { path: 'artnet.discovery', label: 'Find Nodes', type: 'toggle',
      help: 'While the Node IP is a broadcast address, ask the network which nodes are there and send each one its '
        + 'universes directly. Universes no node claims still go to the broadcast address.' },
    { path: 'artnet.sync', label: 'ArtSync', type: 'toggle',
      help: 'Tell the nodes to change every universe at the same instant, so a wall of LED bars moves as one. Only for '
        + 'nodes that support it: a node that has seen ArtSync waits for it.' },
  ],
};

export const SACN = {
  id: 'sacn',
  title: 'sACN (E1.31)',
  desc: 'What consoles and most modern nodes speak. Runs alongside Art-Net or instead of it. Takes effect immediately.',
  fields: [
    { path: 'sacn.enabled', label: 'Enabled', type: 'toggle' },
    { path: 'sacn.host', label: 'Node IP', type: 'text',
      help: 'Blank multicasts to each universe\'s own group (239.255.x.y), which is how sACN is normally deployed. '
        + 'Name a node to unicast to it instead.' },
    { path: 'sacn.priority', label: 'Priority', type: 'number', min: 0, max: 200,
      help: 'Higher wins when two sources drive the same universe. 100 is the E1.31 default.' },
    { path: 'sacn.sourceName', label: 'Source Name', type: 'text', help: 'What the receiving console lists this server as.' },
    { path: 'sacn.universeOffset', label: 'Universe Offset', type: 'number', min: -32767, max: 63999,
      help: 'Art-Net counts universes from 0 and sACN from 1, so +1 lines them up: a fixture on universe 0 goes out as '
        + 'sACN universe 1.' },
    { path: 'sacn.interface', label: 'Network', type: 'select',
      options: (ctx) => [
        { value: '', label: 'Let the computer choose' },
        ...(ctx.networkInterfaces || []).map((i) => ({ value: i.address, label: `${i.name} — ${i.address}` })),
      ],
      missing: (value) => `${value} (not on this machine)`,
      help: 'Which network the multicast groups go out on. Only matters on a machine that is on more than one — pick '
        + 'the one the nodes are on.' },
    { path: 'sacn.cid', label: 'Component ID', type: 'text',
      help: 'How a receiver tells sources apart. Generated on first start and stable from then on — change it only if '
        + 'two servers on the network ended up sharing one.' },
  ],
};

export const HUE = {
  id: 'hue',
  title: 'Philips Hue',
  desc: 'Drive Hue lamps from the same show as the pars, from as many bridges as the house has. Each lamp of a '
    + 'bridge\'s entertainment area is a fixture of its own, added below on a profile for what the bridge says it can '
    + 'show. Build the area in the Hue app first, then pair the bridge here; each bridge streams one area at a time.',
  fields: [
    { path: 'hue.latencyMs', label: 'Pars Delay', type: 'number', unit: 'ms', min: 0, max: 500,
      help: 'Hue lamps answer later than the pars, so every hit lands on the pars first. This holds the Art-Net and sACN '
        + 'output back to match, for every bridge. Start around 50: run the sync test, film it in slow motion, and raise '
        + 'this until the pars and lamps flash together.' },
  ],
};

export const LIVE = {
  id: 'live',
  title: 'Live input',
  desc: 'Hear the music as it plays: the auto show answers what the room hears, and patterns keep its beat. Needs a '
    + 'Python with the packages in requirements.txt (Python, below). Takes effect immediately.',
  fields: [
    { path: 'live.enabled', label: 'Enabled', type: 'toggle' },
    { path: 'live.source', label: 'Listen To', type: 'select', resets: ['live.device'],
      options: () => [
        { value: 'loopback', label: 'What this computer plays' },
        { value: 'input', label: 'An input (line-in or microphone)' },
      ],
      help: 'What this computer plays is the easy one: Spotify, a browser, anything, straight from the sound card with no '
        + 'cable. An input takes a line off the booth output — the only way to hear a set played on other equipment.' },
    { path: 'live.device', label: 'Device', type: 'select',
      options: (ctx, valueOf) => {
        const loopback = valueOf('live.source') !== 'input';
        const devices = ctx.liveDevices || { outputs: [], inputs: [] };
        const names = (loopback ? devices.outputs : devices.inputs) || [];
        const ids = (loopback ? devices.outputIds : devices.inputIds) || [];
        const options = [
          { value: '', label: loopback ? 'The default output' : 'The default input' },
          ...names.map((name) => ({ value: name, label: name })),
        ];
        // A config may name the device by the backend's id (a PulseAudio sink's `auto_null`): show it by its name.
        const current = valueOf('live.device');
        const byId = current && !names.includes(current) ? ids.indexOf(current) : -1;
        if (byId >= 0) options.push({ value: current, label: `${names[byId]} (${current})` });
        return options;
      },
      missing: (value) => `${value} (not found)`,
      help: 'A device that is not plugged in now keeps its name and is used when it comes back.' },
    { path: 'live.autoSync', label: 'Auto-Sync', type: 'toggle',
      help: 'Line a known track\'s show up with what is heard, rather than trust where Spotify or the media session says '
        + 'the song is. The sync offset then only has to cover the lights\' own delay.' },
    { path: 'live.director', label: 'Play By Ear', type: 'toggle',
      help: 'With the auto show on and no analysed track to play — the next one still being analysed, or music nothing '
        + 'can name — answer what is heard: new looks on section changes, bursts on drops, dark in the silences.' },
    { path: 'live.latencyMs', label: 'Room Latency', type: 'number', unit: 'ms', min: -500, max: 500,
      help: 'How much later the room hears the music than this computer does. Positive when the PA is behind the sound '
        + 'card; negative for a line-in off the booth. 0 is right for most setups.' },
    { path: 'analysis.pythonPath', label: 'Python', type: 'text', placeholder: 'auto-detect',
      help: 'Blank auto-detects, preferring an interpreter that can import what the live input needs. Set a full path '
        + 'when pip installed into a different Python than the one that gets picked. Used from the live input\'s next start.',
      note: pythonNote },
  ],
};

export const SHOW = {
  id: 'show',
  title: 'Show',
  desc: 'How the generated show behaves across a night.',
  fields: [
    { path: 'picture.source', label: 'Picture Source', type: 'select',
      options: () => [
        { value: 'effects', label: 'The show\'s effects' },
        { value: 'inspired', label: 'Visualizer colours + motion, with spatial effects' },
        { value: 'visualizer', label: 'The visualizer picture, sampled at each lamp' },
        { value: 'squid', label: 'The squid on the largest LED panel, effects on the rest' },
      ],
      help: 'Colour + motion takes the incoming picture\'s palette and movement speed to drive the selected spatial effect; '
        + 'choose a Visualizer Flow effect in Effects. The visualizer picture arrives from the browser helper\'s --room mode: one '
        + 'colour per lamp cell, read from the picture at the cell\'s place on the plan, so a sweep across the screen '
        + 'sweeps across the room. Voices, pads, overrides and the matrix\'s own pixel feed stay on top either way, and '
        + 'two seconds without a frame shows the effects again. Also switchable in Perform, which sets the picture\'s '
        + 'black point (the level under which a lamp stays dark), an optional sRGB decode for lamps whose output has '
        + 'no gamma of its own, and an optional colour grade, off by default.' },
    { path: 'auto.setMemory', label: 'Remember the Night', type: 'toggle',
      help: 'Each track avoids the palette and the looks of the one before it, keeps some of its colours when the two '
        + 'keys mix, and paces its biggest moments against the tracks before it. Off plans every track as if it were '
        + 'the first of the night.' },
    { path: 'outputs.idleStopMin', label: 'Stop an Unattended Show', type: 'number', unit: 'min', min: 0, max: 1440,
      help: 'While the outputs are disarmed, a show with no control action and no input on any page for this long is '
        + 'stopped as Stop does, pads included, and an open page pauses its preview until Resume preview. A sequence '
        + 'stopped this way starts from the top. Armed, it never stops. 0 never stops: for a remote that leaves a '
        + 'disarmed programme running on purpose.' },
    { path: 'safety.flashLimit', label: 'Flash Limit', type: 'toggle',
      help: 'Photosensitivity: at most three large-area flashes a second (WCAG 2.3.1, ITU-R BT.1702). Strobes are capped '
        + 'at three a second, and a look that would flash the whole rig faster is held to a flicker under a tenth of '
        + 'full brightness. Covers every output, manual looks included. Off by default.' },
    { path: 'hue.strobe', label: 'Hue Lamps Take a Flash', type: 'select',
      options: () => [
        { value: 'flash', label: 'Flash: hard, as the pars do' },
        { value: 'pulse', label: 'Pulse: falling to a glow' },
      ],
      help: 'Flash keeps a look’s hard brightness cuts on Hue lamps; pulse softens them into a 200 ms fall to a glow.' },
  ],
};

export const ENGINE = {
  id: 'engine',
  title: 'Engine',
  desc: 'Where frames are rendered. Applies on the next restart.',
  fields: [
    { path: 'engine.thread', label: 'Render On', type: 'select',
      options: () => [
        { value: 'worker', label: 'Its own thread (recommended)' },
        { value: 'main', label: 'The main thread' },
      ],
      help: 'On its own thread the rig keeps time while the server plans the next track, imports a fixture file or '
        + 'serves the UI. The main thread is only worth choosing to rule the thread out when chasing a problem.',
      note: engineNote },
  ],
};

export const MIDI_CLOCK = {
  id: 'midiClock',
  title: 'MIDI clock out',
  desc: 'Send the tempo the lights keep — the live input\'s or a tap — as MIDI clock, so a drum '
    + 'machine, a DAW or a visuals app plays in the same time. Takes effect immediately.',
  fields: [
    { path: 'midi.clockOutput', label: 'Clock Port', type: 'select',
      options: (ctx) => [{ value: '', label: 'Off' }, ...(ctx.midiOutputs || []).map((name) => ({ value: name, label: name }))],
      missing: (value) => `${value} (not connected)`,
      help: 'A port of its own, not the controller\'s. To reach software on this machine, create a loopback port '
        + '(loopMIDI on Windows, IAC on macOS) and pick it here.' },
  ],
};

export const SERVER = {
  id: 'server',
  title: 'Server & access',
  desc: 'Read before the server starts listening, so these apply on the next restart.',
  fields: [
    { path: 'server.host', label: 'Bind Address', type: 'text',
      help: '127.0.0.1 keeps the rig on this machine. 0.0.0.0 exposes it to the network — which requires an access token.' },
    { path: 'server.port', label: 'Port', type: 'number', min: 1, max: 65535 },
    { path: 'server.token', label: 'Access Token', type: 'secret', generate: true,
      help: 'Required whenever the bind address is not loopback. Each browser needs it once: open the UI at /?token=… , '
        + 'or type it into the prompt the page raises when it is refused.' },
    { path: 'server.publicUrl', label: 'Public URL', type: 'text',
      help: 'Only needed behind a reverse proxy, or when the OAuth callback must use a hostname.' },
  ],
};
