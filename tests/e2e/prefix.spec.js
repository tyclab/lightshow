// The app under a path prefix, framed by another page, as a sidebar ingress or a
// reverse proxy publishes it: the proxy strips the prefix and forwards to the server's root.

import http from 'node:http';
import net from 'node:net';
import { test, expect } from '@playwright/test';
import { reset, until } from './helpers.js';

const PORT = Number(process.env.E2E_PORT) || 3999;
const PREFIX = '/mount/lightshow/';
const HOST_PAGE = `<!DOCTYPE html><html><head><title>Host</title><link rel="icon" href="data:,"></head>
<body style="margin:0"><iframe src="${PREFIX}#perform" style="border:0;width:100vw;height:100vh"></iframe></body></html>`;

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
    const upstream = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: upstreamPath(req.url), headers: req.headers }, (answer) => {
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
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
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

let proxy;
test.beforeAll(async () => { proxy = await startProxy(); });
test.afterAll(async () => {
  proxy.server.closeAllConnections();
  await new Promise((resolve) => proxy.server.close(resolve));
});
test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.delete('/api/palette-override');
});
test.afterEach(async ({ request }) => { await request.delete('/api/palette-override'); });

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
