// A house of 80 rooms in a 10 x 8 grid, walled with doorways: 142 walls, and a lamp of `fixtureId` in 16 of the rooms.
export function walledRoom(fixtureId) {
  const size = 1.2, columns = 10, rows = 8, height = 2.5, walls = [], rooms = [], bindings = [];
  const x0 = -columns * size / 2, z0 = -rows * size / 2;
  for (let c = 0; c < columns; c++) for (let r = 0; r < rows; r++) {
    const x = x0 + c * size, z = z0 + r * size, id = `r${c}-${r}`;
    rooms.push({ id, label: `Room ${c}-${r}`, polygon: [[x, z], [x + size, z], [x + size, z + size], [x, z + size]] });
    if ((c + r) % 5 === 0) bindings.push({ id: `lamp-${id}`, fixtureId, unit: 0, position: { x: x + size / 2, y: 2.2, z: z + size / 2 }, confidence: 'estimated' });
    // The wall on this room's east and south side, each with a doorway.
    if (c < columns - 1) walls.push({ id: `e${id}`, kind: 'box', role: 'wall', position: { x: x + size, y: height / 2, z: z + 0.4 }, size: { x: 0.1, y: height, z: 0.8 } });
    if (r < rows - 1) walls.push({ id: `s${id}`, kind: 'box', role: 'wall', position: { x: x + 0.4, y: height / 2, z: z + size }, size: { x: 0.8, y: height, z: 0.1 } });
  }
  return { version: 1, name: 'Many walls', bounds: { width: columns * size, depth: rows * size, height }, rooms, objects: walls, bindings };
}
