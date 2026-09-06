/**
 * The basemap, in Roam's colours.
 *
 * The owner, 6 Sep 2026, on the Airbnb screenshots: "that is the level of polish
 * that I want to achieve."
 *
 * Those screenshots are Google Maps with an Airbnb style on top — the watermark
 * is in the corner of one of them. Which is the point: what makes them look
 * that way is not Google, it is the style. Default Google Maps looks nothing
 * like it. So the polish is bought here, in a style file we own, rather than
 * bought from a provider by the map load.
 *
 * The colours are the handoff's, not invented: map ground `#EFF8F3`, roads
 * `#DCEAE2`. They are Roam's own mint and hairline, so the map is a part of the
 * app rather than a rectangle of somebody else's software embedded in it.
 *
 * **The tiles.** Vector tiles from OpenFreeMap, which is free, needs no key and
 * asks for no attribution beyond OpenStreetMap's. That matters twice over: no
 * key can leak from the web bundle because there is no key (CLAUDE.md), and
 * there is no per-view bill, which a map on every trip screen would otherwise
 * run up. It is a deliberate first step and not the end of the road — the
 * production version of this is the same tiles served from our own object
 * store, which is a change to one URL. What it is *not* is
 * `tile.openstreetmap.org`, which is the Foundation's volunteer raster server
 * and whose usage policy does not permit an app of any size.
 *
 * The layer list is deliberately short. A basemap under a trip is scenery: it
 * has to say where the roads and the water are and then get out of the way, so
 * that the only things with real colour on the screen are the household's own
 * pins.
 */

const TILES = 'https://tiles.openfreemap.org/planet';

const INK = '#201E1D';
const MUTED = '#6B6663';
const GROUND = '#EFF8F3';
const ROAD = '#DCEAE2';
const WATER = '#CBE3EE';
const GREEN = '#DFF0E5';
const BUILDING = '#E7F1EB';
const LINE = '#E5EFEA';

/** The style, in Roam's palette. `dark` inverts the ground so the pins still read at night. */
export function roamMapStyle(dark = false): any {
  const ground = dark ? '#1E1E23' : GROUND;
  const road = dark ? '#2B2B30' : ROAD;
  const water = dark ? '#1B2A31' : WATER;
  const green = dark ? '#212A25' : GREEN;
  const building = dark ? '#24242A' : BUILDING;
  const label = dark ? '#8F8D93' : MUTED;
  const halo = dark ? '#17171A' : '#FFFFFF';
  const placeLabel = dark ? '#F3F2F2' : INK;

  return {
    version: 8,
    // Archivo is the app's face and is not in the glyph set, so labels use the
    // set's own grotesque rather than a fallback that changes width per zoom.
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      openmaptiles: { type: 'vector', url: TILES },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': ground } },
      {
        id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
        paint: { 'fill-color': water },
      },
      {
        id: 'landcover-green', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover',
        filter: ['in', 'class', 'wood', 'grass', 'park'],
        paint: { 'fill-color': green, 'fill-opacity': 0.9 },
      },
      {
        id: 'park', type: 'fill', source: 'openmaptiles', 'source-layer': 'park',
        paint: { 'fill-color': green, 'fill-opacity': 0.7 },
      },
      {
        id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building',
        minzoom: 14,
        paint: { 'fill-color': building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 16, 1] },
      },
      // Roads, thinnest first so the big ones draw over the small ones.
      {
        id: 'road-minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
        filter: ['in', 'class', 'minor', 'service', 'track', 'path'],
        minzoom: 12,
        paint: { 'line-color': road, 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 12, 0.4, 18, 6] },
      },
      {
        id: 'road-secondary', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
        filter: ['in', 'class', 'secondary', 'tertiary'],
        paint: { 'line-color': road, 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 0.6, 18, 10] },
      },
      {
        id: 'road-primary', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
        filter: ['in', 'class', 'primary', 'trunk'],
        paint: {
          'line-color': dark ? '#33333A' : '#D2E4DA',
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 6, 0.8, 18, 14],
        },
      },
      {
        id: 'road-motorway', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
        filter: ['==', 'class', 'motorway'],
        paint: {
          'line-color': dark ? '#3B3B43' : '#C6DED2',
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 5, 1, 18, 18],
        },
      },
      {
        id: 'boundary', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary',
        filter: ['<=', 'admin_level', 4],
        paint: { 'line-color': dark ? '#3A3A42' : LINE, 'line-width': 1, 'line-dasharray': [3, 2] },
      },
      // Labels. Places first and small; the household's own pins are what the
      // eye should find, so the basemap's names stay quiet.
      {
        id: 'label-place', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place',
        filter: ['in', 'class', 'city', 'town', 'village', 'suburb'],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 14, 14],
          'text-max-width': 8,
        },
        paint: { 'text-color': placeLabel, 'text-halo-color': halo, 'text-halo-width': 1.4 },
      },
      {
        id: 'label-road', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name',
        minzoom: 13,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'symbol-placement': 'line',
        },
        paint: { 'text-color': label, 'text-halo-color': halo, 'text-halo-width': 1.2 },
      },
    ],
  };
}
