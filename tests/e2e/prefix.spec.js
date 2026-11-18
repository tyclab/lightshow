// The app under a path prefix, framed by another page, as a sidebar ingress or a reverse proxy
// publishes it: the proxy strips the prefix, sets Host to the server, reports the browser's host
// in X-Forwarded-Host and passes the browser's Origin through.

import http from 'node:http';
import net from 'node:net';
import { test, expect } from '@playwright/test';
import { reset, until } from './helpers.js';

const PORT = Number(process.env.E2E_PORT) || 3999;
const BACKEND = `127.0.0.1:${PORT}`;
const PREFIX = '/mount/lightshow/';
const HOST_PAGE = `<!DOCTYPE html><html><head><title>Host</title><link rel="icon" href="data:,"></head>
<body style="margin:0"><iframe src="${PREFIX}#perform" style="border:0;width:100vw;height:100vh"></iframe></body></html>`;
const FOREIGN_PAGE = '<!DOCTYPE html><html><head><title>Foreign</title><link rel="icon" href="data:,"></head><body></body></html>';

const forwardHeaders = (req) => ({ ...req.headers, host: BACKEND, 'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host });

function startProxy() {
  const seen = { outside: [], sockets: [] };
  const upstreamPath = (url) => url.slice(PREFIX.length - 1);
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HOST_PAGE);
      return;
    }
    if (!req.url.startsWith(PREFIX)) {
      seen.outside.push(req.url);
      res.writeHead(404);
      res.end();
      return;
    }
    const upstream = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: upstreamPath(req.url), headers: forwardHeaders(req) }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith(PREFIX)) {
      seen.outside.push(req.url);
      socket.destroy();
      return;
    }
    seen.sockets.push(req.url.split('?')[0]);
    const upstream = net.connect(PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${upstreamPath(req.url)} HTTP/1.1`];
      for (const [name, value] of Object.entries(forwardHeaders(req))) lines.push(`${name}: ${value}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, seen, origin: `http://127.0.0.1:${server.address().port}`,
  })));
}

// Another origin: a page that is not the one the proxy serves.
function startForeign() {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FOREIGN_PAGE); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://localhost:${server.address().port}` })));
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

let proxy;
let foreign;
test.beforeAll(async () => { proxy = await startProxy(); foreign = await startForeign(); });
test.afterAll(async () => { await stop(proxy.server); await stop(foreign.server); });
test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.delete('/api/palette-override');
});
test.afterEach(async ({ request }) => {
  await request.delete('/api/palette-override');
  await request.post('/api/outputs/disarm');
});

test('framed under a prefix, the page, its socket, its worker and a palette pick stay under it', async ({ page, context, request }) => {
  const paths = [];
  const failed = [];
  context.on('request', (r) => paths.push(new URL(r.url()).pathname));
  context.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  context.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.url()} ${r.status()}`); });

  await page.goto(`${proxy.origin}/`);
  const app = page.frameLocator('iframe');
  await expect(app.locator('.status-dot.connected')).toBeVisible();
  const frame = page.frames().find((f) => f.url().startsWith(`${proxy.origin}${PREFIX}`));
  expect(await frame.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(`${proxy.origin}${PREFIX}`);

  const strip = app.locator('.palette-strip');
  await strip.getByRole('button', { name: 'Global override', exact: true }).click();
  const pad = strip.locator('[data-palette]').first();
  const id = await pad.getAttribute('data-palette');
  await pad.click();
  await expect(pad).toHaveAttribute('aria-pressed', 'true');
  await until(request, (s) => s.paletteOverrideId === id);

  await page.reload();
  await expect(app.locator('.status-dot.connected')).toBeVisible();
  await expect(app.locator(`.palette-strip [data-palette="${id}"]`)).toBeVisible();
  const again = page.frames().find((f) => f.url().startsWith(`${proxy.origin}${PREFIX}`));
  expect(await again.evaluate(() => !!navigator.serviceWorker.controller), 'the worker serves its own scope').toBe(true);
  expect(await page.evaluate(() => navigator.serviceWorker.controller), 'and not the page around it').toBeNull();

  expect(paths.filter((p) => p !== '/' && !p.startsWith(PREFIX))).toEqual([]);
  expect(proxy.seen.outside).toEqual([]);
  expect(proxy.seen.sockets).toContain(`${PREFIX}socket.io/`);
  expect(failed).toEqual([]);
});

test('through the proxy, another origin is refused as it is directly: a control action and the socket', async ({ page, request }) => {
  const armed = async () => (await (await request.get('/api/control')).json()).control.armed;
  const arm = async (base, origin) => {
    const current = (await (await request.get('/api/control')).json()).control;
    return request.post(`${base}api/control`, { headers: { Origin: origin }, data: { ...current, action: 'arm' } });
  };
  const handshake = (base, origin) => request.get(`${base}socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } });
  const viaProxy = `${proxy.origin}${PREFIX}`;
  const direct = `http://${BACKEND}/`;

  for (const base of [direct, viaProxy]) {
    const refused = await arm(base, 'https://evil.example');
    expect(refused.status(), `${base} arm`).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'Cross-origin request refused' });
    expect(await armed()).toBe(false);
    expect((await handshake(base, 'https://evil.example')).status(), `${base} handshake`).toBe(403);
  }
  expect((await handshake(viaProxy, proxy.origin)).status(), 'the page the proxy serves').toBe(200);
  expect((await arm(viaProxy, proxy.origin)).status()).toBe(200);
  expect(await armed()).toBe(true);

  // A page on another origin opening the socket through the proxy, as a browser does.
  await page.goto(`${foreign.origin}/`);
  const opened = (url) => page.evaluate((u) => new Promise((resolve) => {
    const ws = new window.WebSocket(u);
    ws.onmessage = (event) => { resolve(String(event.data).slice(0, 1)); ws.close(); };
    ws.onerror = () => resolve('refused');
    setTimeout(() => resolve('silent'), 5000);
  }), url);
  const socketUrl = `${viaProxy.replace('http:', 'ws:')}socket.io/?EIO=4&transport=websocket`;
  expect(await opened(socketUrl)).toBe('refused');
  await page.goto(`${proxy.origin}/`);
  expect(await opened(socketUrl), 'the engine.io open packet').toBe('0');
});
