// The server parses, validates and stores a room import on its main thread, about 0.1 s per MB; close to three
// times the largest real room (a whole flat with its detailed furniture, 4.6 MB) refuses only a runaway file.
export const ROOM_SCENE_BODY_LIMIT = 12 * 1024 * 1024;
