// The connect log line says which protocol a client speaks and where it came from,
// so a protocol 1 client that keeps the engine awake can be found in Loki.
import test from 'node:test';
import assert from 'node:assert';

import { describeClient } from '../../src/server/sockets.ts';

const socket = (auth, headers = {}, address = '192.0.2.5') => ({ id: 'abc123', handshake: { auth, headers, address } });

test('the connect line names protocol, address and user agent', () => {
  assert.equal(describeClient(socket({ protocol: 2 }, { 'user-agent': 'Mozilla/5.0 (X11)' })),
    'Client connected: abc123 (protocol 2, 192.0.2.5, Mozilla/5.0 (X11))');
  assert.equal(describeClient(socket({ token: 't' }, { 'user-agent': 'node-fetch' })),
    'Client connected: abc123 (protocol 1, 192.0.2.5, node-fetch)', 'no protocol in auth: the original protocol');
  assert.equal(describeClient(socket(undefined)), 'Client connected: abc123 (protocol 1, 192.0.2.5)', 'no user agent: nothing appended');
});

test('behind the proxy the first forwarded address wins', () => {
  assert.equal(describeClient(socket({ protocol: 2 }, { 'x-forwarded-for': '192.168.3.7, 198.51.100.1' })),
    'Client connected: abc123 (protocol 2, 192.168.3.7)');
  assert.equal(describeClient(socket({ protocol: 2 }, { 'x-forwarded-for': ['192.168.3.8'] })),
    'Client connected: abc123 (protocol 2, 192.168.3.8)', 'a header array is read like the string');
  assert.equal(describeClient({ id: 'abc123', handshake: { auth: {}, headers: {}, address: '' } }),
    'Client connected: abc123 (protocol 1, unknown address)');
});
