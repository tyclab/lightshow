// The live input as heard, to the pages subscribed to `samples` (a visualizer drawing from the room's sound).
// Each subscriber has at most one packet unacknowledged; samples arriving meanwhile wait in a ring of the
// newest, so a slow or stalled subscriber is sent the newest next, never a backlog. Nobody subscribed, the
// live input is asked for none.

import type { LiveSamples } from '../live-input.ts';

/** The most one packet carries: the newest 1024 samples, 46 ms at 22.05 kHz. Older ones a subscriber missed are dropped. */
export const SAMPLES_PER_PACKET = 1024;
/** A packet unacknowledged this long no longer holds the subscriber back. */
export const SAMPLES_ACK_MS = 1000;

export interface SamplePacket {
  /** The live input process the samples are from, unique across server restarts: a new one counts from zero again. */
  g: number;
  /** The stream's sample count after the newest sample in `data`. */
  end: number;
  rate: number;
  /** Mono 16-bit little-endian samples, contiguous up to `end`. */
  data: Buffer;
  /** The engine's wall clock (ms) when the newest block was read from the device: a diagnostic, as good as the clocks' sync. */
  at: number;
}

export interface SampleSocket {
  id: string;
  connected: boolean;
  timeout(ms: number): { emit(event: 'samples', packet: SamplePacket, ack: (err: Error | null) => void): unknown };
}

interface Subscriber { socket: SampleSocket; waiting: boolean; sent: number }

export class SampleRelay {
  readonly #want: (on: boolean) => void;
  readonly #subscribers = new Map<string, Subscriber>();
  readonly #ring = Buffer.alloc(SAMPLES_PER_PACKET * 2);
  #stream = -1;
  #rate = 0;
  #start = 0;
  #end = 0;
  #at = NaN;

  constructor({ want }: { want: (on: boolean) => void }) {
    this.#want = want;
  }

  get subscribers(): number {
    return this.#subscribers.size;
  }

  add(socket: SampleSocket): void {
    if (this.#subscribers.has(socket.id)) return;
    this.#subscribers.set(socket.id, { socket, waiting: false, sent: this.#end });
    if (this.#subscribers.size === 1) this.#want(true);
  }

  remove(id: string): void {
    if (!this.#subscribers.delete(id) || this.#subscribers.size) return;
    this.#stream = -1;
    this.#want(false);
  }

  push(block: LiveSamples): void {
    const count = block.data.length / 2, first = block.end - count;
    if (!this.#subscribers.size || first < 0) return;
    if (block.stream !== this.#stream || block.rate !== this.#rate || first !== this.#end) {
      // A new process, or samples that never came: the stream starts again at this block.
      this.#stream = block.stream;
      this.#rate = block.rate;
      this.#start = this.#end = first;
      for (const subscriber of this.#subscribers.values()) subscriber.sent = first;
    }
    this.#write(block.data, block.end);
    this.#at = block.at;
    for (const subscriber of this.#subscribers.values()) if (!subscriber.waiting) this.#send(subscriber);
  }

  #write(data: Buffer, end: number): void {
    const count = Math.min(data.length / 2, SAMPLES_PER_PACKET), bytes = data.subarray(data.length - count * 2);
    const at = ((end - count) % SAMPLES_PER_PACKET) * 2, head = Math.min(bytes.length, this.#ring.length - at);
    bytes.copy(this.#ring, at, 0, head);
    bytes.copy(this.#ring, 0, head);
    this.#end = end;
    this.#start = Math.max(this.#start, end - SAMPLES_PER_PACKET);
  }

  #read(from: number): Buffer {
    const out = Buffer.allocUnsafe((this.#end - from) * 2);
    const at = (from % SAMPLES_PER_PACKET) * 2, head = Math.min(out.length, this.#ring.length - at);
    this.#ring.copy(out, 0, at, at + head);
    this.#ring.copy(out, head, 0, out.length - head);
    return out;
  }

  #send(subscriber: Subscriber): void {
    const from = Math.max(subscriber.sent, this.#start);
    if (from >= this.#end || !subscriber.socket.connected) return;
    subscriber.sent = this.#end;
    subscriber.waiting = true;
    const packet: SamplePacket = { g: this.#stream, end: this.#end, rate: this.#rate, data: this.#read(from), at: this.#at };
    subscriber.socket.timeout(SAMPLES_ACK_MS).emit('samples', packet, () => {
      subscriber.waiting = false;
      if (this.#subscribers.get(subscriber.socket.id) === subscriber) this.#send(subscriber);
    });
  }
}
