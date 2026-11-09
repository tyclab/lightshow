import { createHash } from 'node:crypto';
import { JsonStore } from './json-store.ts';
import { configFile } from './config-dir.ts';
import { roomSceneSchema } from '../shared/room-scene.ts';
import type { RoomScene } from '../shared/room-scene.ts';

export class RoomSceneStore extends JsonStore {
  declare _room: RoomScene | null;
  declare _revision: string;

  constructor(file = configFile('stage-room.json')) {
    super(file, { tag: 'stage room', fallback: 'using the generic stage', mode: 0o600 });
    this._room = null;
    this._revision = 'empty';
  }

  useDefaults(): void {
    this._room = null;
    this._revision = 'empty';
  }

  load(): this {
    this.publish(this.readValid(roomSceneSchema.nullable()) ?? null);
    return this;
  }

  /** The loaded room without a copy, for readers that never change it. */
  peek(): { room: RoomScene | null; revision: string } {
    return { room: this._room, revision: this._revision };
  }

  snapshot(): { room: RoomScene | null; revision: string } {
    return { room: structuredClone(this._room), revision: this._revision };
  }

  replace(raw: unknown): void {
    this.save(roomSceneSchema.nullable().parse(raw));
  }

  /** Stores a room the schema has already parsed, without parsing it twice. */
  save(room: RoomScene | null): void {
    this.writeJson(room);
    this.publish(room);
  }

  // Compact, unlike other stores: indenting a mesh-heavy room puts each coordinate on a line of its own, four times the bytes.
  writeJson(value: unknown): void {
    this.write(`${JSON.stringify(value)}\n`);
  }

  private publish(room: RoomScene | null): void {
    this._room = room;
    this._revision = room === null ? 'empty' : createHash('sha256').update(JSON.stringify(room)).digest('hex');
  }
}

let shared: RoomSceneStore | null = null;

/** The one room store the routes and the engine share, loaded on first use. */
export function sharedRoomScene(): RoomSceneStore {
  return (shared ??= new RoomSceneStore().load());
}
