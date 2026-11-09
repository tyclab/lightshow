// socket.io-client for component tests: a socket that is never connected and
// remembers what it was sent, so public-src/state.js loads in Node. `fire`
// plays a server event to every listener, for a test that connects it itself.

export function io() {
  const handlers = new Map();
  return {
    connected: false,
    active: false,
    auth: {},
    sent: [],
    on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); return this; },
    emit(...args) { this.sent.push(args); return this; },
    connect() { return this; },
    fire(event, ...args) { for (const fn of handlers.get(event) || []) fn(...args); },
  };
}
