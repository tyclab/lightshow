# Rooms in Stage

Stage can draw a private room model instead of the generic venue. Open Stage's
room controls to import a room JSON file, place fixtures, and edit or remove
bindings. Room data lives in `config/stage-room.json`, served through the same
authenticated API as the lighting controls. It is not part of a public source
checkout.

Use Download room JSON to preserve saved placements before replacement. Replacing
or clearing a room with saved positions asks for confirmation, as does discarding
changed placement fields.

Room geometry changes the preview and the room form of the Spatial effects, which
sample each light's bound position in metres. It does not move fixtures in the
engine's Rig plot, alter any other effect or arm outputs. Keep those placements consistent
when commissioning the room. Estimated dimensions and bindings remain marked
as estimates; a detailed model does not prove measured optical timing.

An imported room displays explicit fixture bindings. A fixture without a binding
remains listed for placement; when it has a Rig plot position, Stage draws it where the
effects sample it (`plotPosition` in `src/shared/space.ts`: plot x and y percent of the
room's width and depth, height percent of its height), each cell of an explicit cell map at
its own point inside a dark, see-through body spanning its pixels, and the list says so. A fixture with no position anywhere is not drawn, so no
location is invented. Cells left unbound in a partly bound fixture (a pixel map's gaps) are
not drawn either; the effects sample each at the nearest bound cell of its fixture.
One output unit can have several visual bindings when a shared channel drives
several physical lights. `unit` is the zero-based light/cell within a fixture,
not a DMX channel or an index in the entire rig. On a panel whose grid has places
without a cell (a WLED read with its ledmap), `unit` counts the cells there are, in
row-major order, not the grid's places; reading such a WLED again in Rig → Outputs
moves the room's bindings for it to the cells at their columns and rows.

## Room format

Version 1 uses metres and radians. The floor is centred on the origin: `x` is
left/right, `y` is height, and `z` is floor depth. Apply the same transform to
walls, furniture and fixture positions when exporting a floor plan. A source's
revision and measurement confidence can be retained in the model.

```json
{
  "version": 1,
  "name": "Example room",
  "source": { "name": "Room survey", "revision": "1", "confidence": "estimated" },
  "bounds": { "width": 6, "depth": 4, "height": 3 },
  "rooms": [{
    "id": "main", "label": "Main room",
    "polygon": [[-3, -2], [3, -2], [3, 2], [-3, 2]]
  }],
  "objects": [{
    "id": "back-wall", "kind": "box", "role": "wall",
    "position": { "x": 0, "y": 1.5, "z": -2 },
    "size": { "x": 6, "y": 3, "z": 0.1 }
  }],
  "bindings": [{
    "id": "lamp", "fixtureId": 17, "unit": 0,
    "position": { "x": -1, "y": 2.2, "z": 0 },
    "confidence": "estimated"
  }]
}
```

Objects are `box`, `cylinder`, `prism` or `mesh`, with role `wall` or `furniture`.
Position is the object's centre; size is its local width, height and depth.
A `box` wall stops a directional beam and takes its pool; beams pass other
shapes and stop at the bounds' floor, ceiling and walls.
Optional `rotation` contains `x`, `y`, `z` Euler angles in radians. A cylinder's
local axis is Y; X/Z sizes are diameters. A prism also needs a local X/Z polygon
within its width/depth. Room polygons use world X/Z coordinates. Colours are
optional `#RRGGBB` values. IDs must be unique within each collection.

A `mesh` contains `mesh: { vertices: [[x, y, z], ...], triangles: [[i, j, k], ...] }`.
Vertices are normalized local coordinates in −0.5…0.5, scaled by the object's
`size`, then rotated and placed at `position`. Centre the geometry around its
local origin when exporting. Triangle indices are zero-based and must refer to
three different existing vertices enclosing a nonzero area; winding determines
the outside face. Near-zero triangles (cross-product squared length ≤ 1e-20) are
rejected. Meshes support furniture and walls; screen meshes need texture coordinates
and are not accepted. Stage draws each mesh with an index of its own, 32-bit where
it needs one, so only the request limit below bounds mesh geometry; decimate detailed
source models and round exported coordinates to stay within it. Downloads use compact JSON so valid detailed rooms can be imported again. Stage computes smooth surface normals and uses fixed neutral lighting
to show relief without drawing triangle outlines. Object colours affect the preview
only; they do not change fixture output colours. Mesh data is inline and private,
with no external model URL or source asset needed by the public application.

A physical light driven by several output units can use `aggregation: "weightedMean"`
and `sources: [{ "fixtureId": 17, "unit": 0, "weight": 1 }, ...]` instead of
`fixtureId`/`unit`. It draws one marker whose linear RGB is the weighted mean of
the sources. Weights must be positive and their sum finite; a binding accepts up
to 64 unique source units. Missing sources count as black and appear as incomplete
coverage. This estimates the whole lamp's colour, without inventing segment
positions. The placement editor can add, change or remove source units and weights.
Shared source units are listed explicitly: changing one output can affect several
physical lights, regardless of their separate preview markers.

A room binding may include a surveyed `path` of 2–128 points in room metres. Stage draws
its corners as a continuous strip using that binding's source colour, including weighted
sources. Moving its position translates the whole path. Point-only imports remain markers;
re-export known strip geometry to give them their physical shape. Room imports accept at most
8192 strip edges and reject zero-length edges and paths outside the room bounds.

A binding's optional `lightTarget: { x, y, z }` aims its preview at a lit surface.
It uses the room coordinate frame and must differ from the emitter (the path
midpoint for strips). Optional `lightTargetConfidence` is `estimated` or
`measured`; photo-derived directions are estimates. The target overrides fixture
pan/tilt in this room while keeping its beam spread, with a 100° wash for lamps
without a beam spread. The first opaque box wall or furniture surface, or room
boundary, receives the pool. Other object shapes do not stop these beams.
Physical positions, output addressing and effect sampling remain unchanged.

How strongly a lamp lights the room follows its lumen at full white, by one rule. An 806 lm bulb
counts as 1 in the room's lights, which fall off with the square of the distance. A Hue lamp
counts by the product its bridge names (a GU10 spot 350 lm, a candle 470 lm, a Play bar 530 lm,
a light strip 800 lm a metre; `HUE_LUMEN` in `src/shared/emission.ts`, the maker's figures at
4000 K, rounded), any other strip 484 lm a metre of surveyed run and a pixel 8 lm. A panel's
pixels closer than a 60-per-metre strip's are smaller LEDs and count by the area each has
(a 5.6 mm pitch gives 0.9 lm a pixel); that figure is an estimate. A beam's pool is drawn at
the lumen it spreads over each square metre, full strength at 97 lm/m² (a 350 lm, 36° spot on
the floor 2.45 m below), so a wide wash from a small lamp is faint. A lamp of unknown lumen (a
DMX par) keeps a bulb's 1 and a full-strength pool, and an aimed lamp without a product counts
as a bulb. The generic venue is drawn as before.

Optional `anchors` name points effects can start from, such as speakers:
`[{ "id": "speakerLeft", "position": { "x": -1.5, "y": 1, "z": -1.5 } }]`. Optional
`listeners` are listening positions with a facing in degrees, seen from above: 0 looks
toward −z (the top of the Rig plot) and 90 toward +x:
`[{ "id": "desk", "position": { "x": 0, "y": 1.15, "z": 0 }, "facingDeg": 0 }]`.
Both stay inside the room bounds; a room holds up to 32 anchors and 8 listeners, and their
IDs must be unique across the whole room. A room without them is unchanged.

Models accept up to 128 room polygons, 1,500 objects and 4,096 bindings, with up
to 128 vertices per polygon and 8,192 total source references. A request carries at most
12 MiB of JSON: the server parses, validates and stores an import on its main thread, about
0.1 s per MB, and 12 MiB is three times the largest real room (a whole flat with detailed
furniture, 4.2 MB). External asset URLs, scripts and unrecognised fields are rejected. Keep the original floor-plan
source and measurements separately; this is a rendering format, not an archive
of the floor-plan source.

## API and concurrent changes

`GET /api/stage/room` returns `{ ok, room, revision }`. With no imported model,
`room` is `null` and `revision` is `empty`. GET supports `If-None-Match` and 304
responses, so clients can check for updates without downloading unchanged
geometry. The browser keeps the room it last loaded or saved
(`public-src/stage-room.js`) and asks with `If-None-Match` whenever a view that
draws it mounts: while the revision stands, Show and Effects keep the same room
object, and the 3D scene keeps the room and rig it built from it.

`PUT /api/stage/room` accepts the room object above. `DELETE /api/stage/room`
returns to the generic venue. Both require `If-Match` with the revision from
GET: missing revisions return 428; an intervening edit returns 412. Reload and
review that edit before replacing it. Failed validation or disk writes preserve
the previously loaded model.

A furniture object may set `lightBindingId` to an existing binding ID. Its surface
retains its base colour while off and emits that binding's current Stage RGB, including weighted
source mixtures and missing-source black contributions. The binding's separate
marker is replaced by the object; its coverage and source data are retained. This
uses the same live/rehearsal frame and power-state semantics as other Stage lights.
Lit surfaces blend their neutral diffuse colour toward 0.35 × the current linear RGB and
add restrained emission (intensity 0.25), preserving hue and directional relief.
An off frame removes emission while leaving the physical shell visible. Multiple
object parts may share one binding; unbound parts remain ordinary scenery. This is
preview rendering only and never moves or changes an output fixture.

A bound furniture object can optionally set `lightTint: "#c4dbea"` to model a
coloured translucent material. Stage converts both the tint and live RGB to linear
light and multiplies them before shading; the default white tint preserves existing
rendering. The tint filters illumination without adding light to black frames or
changing output colours. The object's base `color` remains its appearance when off.

Objects may set `opacity` from 0 (invisible) to 1 (opaque), for example `0.4`
for glass. Omitted opacity preserves the opaque default. Transparent objects
blend with the scenery behind them without writing depth; this affects only Stage.
