import { decodeDmxFrame } from '../../src/shared/dmx-frame.ts';

// Keep an actual DMX frame on the display while a screenshot crosses a short pulse.
export async function dmxLatch(page) {
  let predicate = null;
  let held = null;
  let resume = null;
  const release = () => { held = null; predicate = null; resume?.(); resume = null; };
  await page.routeWebSocket(/socket\.io/, (socket) => {
    const server = socket.connectToServer();
    let header = null;
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === 'string' && message.startsWith('451-') && message.includes('"dmx-frame"')) {
        header = message;
        return;
      }
      if (header && typeof message !== 'string') {
        const pending = header;
        header = null;
        if (held) { resume = () => { socket.send(pending); socket.send(message); }; return; }
        const frame = decodeDmxFrame(message);
        if (predicate && frame && predicate(frame)) {
          held = frame;
          predicate = null;
        }
        socket.send(pending);
        socket.send(message);
        return;
      }
      socket.send(message);
    });
  });
  return {
    holdWhen(match) { release(); predicate = match; },
    release,
    frame: () => held,
  };
}
