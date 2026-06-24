// Central configuration: aircraft, airports, default keys, control bindings.

// ── API keys ────────────────────────────────────────────────────────────────
// Optional. The sim runs with NO keys using free worldwide satellite imagery.
// Users can paste keys in-app (World tab); those are saved to localStorage and
// take precedence over anything here.
export const DEFAULT_ION_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIyYzk1N2YwNC0zMzk5LTQxMzMtYTdlMS1lYzU3MTcyNDljYjkiLCJpZCI6NDQ4MzA4LCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3ODIyNjI1ODl9.mM_tnWpnO7I6Rs3YXzwLH1rxA3BetMKWYbokXG09mYU'; // Cesium ion token → 3D terrain + buildings
export const DEFAULT_GOOGLE_KEY = '';  // Google Maps Platform "Map Tiles API" key

// ── Aircraft definitions ─────────────────────────────────────────────────────
// Real aircraft (3D models from the GPLv2 Flightradar24 fr24-3d-models project,
// converted to glTF 2.0). All values are SI (kg, m, m², N, rad). Physics is a
// point-mass 6DOF-lite model (see flightModel.js). `axis:'fr24'` re-maps the
// model's nose=+Y / up=+X axes onto Cesium's nose=+X / up=+Z convention.
export const AIRCRAFT = {
  pa28: {
    id: 'pa28',
    name: 'Piper PA-28 Cherokee',
    blurb: 'Real single-engine trainer. Slow, light and forgiving — start here.',
    model: '/assets/models/pa28_v2.glb',
    axis: 'fr24',
    scale: 1.0,
    minimumPixelSize: 64,
    mass: 1100, wingArea: 15.8, clAlpha: 5.7, cl0: 0.25, clMax: 1.55,
    cd0: 0.030, inducedK: 0.050, maxThrust: 3600,
    flapClBonus: 0.5, flapDrag: 0.02, gearDrag: 0.0,
    rollRate: 1.8, pitchRate: 1.0, yawRate: 0.6,
    wheelHeight: 1.4, stallSpeed: 27, vne: 92,
    span: 9.1, Ixx: 1300, Iyy: 1700, Izz: 2800,
    surfaces: {
      aileronL: { node: 'aileronG', axis: 'x', pivot: [-3.916, -0.726, 1.023], max: 16, driver: 'roll', sign: 1 },
      aileronR: { node: 'aileronD', axis: 'x', pivot: [3.693, -0.729, 1.062], max: 16, driver: 'roll', sign: -1 },
      flapL: { node: 'voletG', axis: 'x', pivot: [-1.743, -0.743, 0.78], max: 22, driver: 'flaps', sign: 1 },
      flapR: { node: 'voletD', axis: 'x', pivot: [1.49, -0.743, 0.78], max: 22, driver: 'flaps', sign: 1 },
      rudder: { node: 'direction', axis: 'z', pivot: [-0.126, -4.269, 2.066], max: 18, driver: 'yaw', sign: 1 },
    },
    gearNodes: ['roueA', 'roueD', 'roueG', 'pate', 'patte'],
    cockpit: { forward: 2.4, up: 1.0 }, chase: { back: 22, up: 7 }, propVisual: true,
  },
  citation: {
    id: 'citation',
    name: 'Cessna Citation',
    blurb: 'Real business jet. Fast and smooth — a great step up from the trainer.',
    model: '/assets/models/citation_v2.glb',
    axis: 'fr24',
    scale: 1.0,
    minimumPixelSize: 64,
    mass: 8000, wingArea: 30, clAlpha: 5.3, cl0: 0.14, clMax: 1.4,
    cd0: 0.021, inducedK: 0.042, maxThrust: 50000,
    flapClBonus: 0.6, flapDrag: 0.03, gearDrag: 0.02,
    rollRate: 1.6, pitchRate: 0.9, yawRate: 0.45,
    wheelHeight: 2.0, stallSpeed: 50, vne: 235,
    span: 16, Ixx: 28000, Iyy: 35000, Izz: 55000,
    surfaces: {
      aileronL: { node: 'LHaileron', axis: 'x', pivot: [-5.683, -1.407, 0.691], max: 16, driver: 'roll', sign: 1 },
      aileronR: { node: 'RHaileron', axis: 'x', pivot: [5.736, -1.407, 0.691], max: 16, driver: 'roll', sign: -1 },
      elevatorL: { node: 'LHelevator', axis: 'x', pivot: [-1.396, -6.616, 2.077], max: 16, driver: 'pitch', sign: 1 },
      elevatorR: { node: 'RHelevator', axis: 'x', pivot: [1.441, -6.616, 2.077], max: 16, driver: 'pitch', sign: 1 },
      flapL: { node: 'LHflap', axis: 'x', pivot: [-2.984, -1.775, 0.476], max: 22, driver: 'flaps', sign: 1 },
      flapR: { node: 'RHflap', axis: 'x', pivot: [3.037, -1.775, 0.476], max: 22, driver: 'flaps', sign: 1 },
      rudder: { node: 'Rudder', axis: 'z', pivot: [0.027, -7.363, 2.784], max: 18, driver: 'yaw', sign: 1 },
    },
    cockpit: { forward: 6.5, up: 1.6 }, chase: { back: 40, up: 12 }, propVisual: false,
  },
  b738: {
    id: 'b738',
    name: 'Boeing 737-800',
    blurb: 'Real short-haul airliner. Heavy — needs runway, speed and planning.',
    model: '/assets/models/b738_v2.glb',
    axis: 'fr24',
    scale: 1.0,
    minimumPixelSize: 80,
    mass: 65000, wingArea: 125, clAlpha: 5.0, cl0: 0.16, clMax: 1.5,
    cd0: 0.019, inducedK: 0.043, maxThrust: 240000,
    flapClBonus: 0.8, flapDrag: 0.035, gearDrag: 0.022,
    rollRate: 1.1, pitchRate: 0.65, yawRate: 0.3,
    wheelHeight: 2.4, stallSpeed: 62, vne: 290,
    span: 35.8, Ixx: 2400000, Iyy: 4500000, Izz: 6700000,
    surfaces: {
      aileronL: { node: 'lhaileron', axis: 'x', pivot: [-12.262, -3.138, 0.606], max: 16, driver: 'roll', sign: 1 },
      aileronR: { node: 'rhaileron', axis: 'x', pivot: [12.41, -3.138, 0.606], max: 16, driver: 'roll', sign: -1 },
      elevatorL: { node: 'lhelevator', axis: 'x', pivot: [-2.533, -18.065, 2.094], max: 16, driver: 'pitch', sign: 1 },
      elevatorR: { node: 'rhelevator', axis: 'x', pivot: [2.705, -18.064, 2.094], max: 16, driver: 'pitch', sign: 1 },
      flapL: { node: 'flapO_B', axis: 'x', pivot: [-8.025, -1.701, 0.105], max: 22, driver: 'flaps', sign: 1 },
      flapR: { node: 'rhflapO_B', axis: 'x', pivot: [8.173, -1.701, 0.105], max: 22, driver: 'flaps', sign: 1 },
      rudder: { node: 'rudder', axis: 'z', pivot: [17.893, -0.006, 5.984], max: 18, driver: 'yaw', sign: 1 },
    },
    cockpit: { forward: 16, up: 2.4 }, chase: { back: 75, up: 20 }, propVisual: false,
  },
  a320: {
    id: 'a320',
    name: 'Airbus A320',
    blurb: 'Real twin-jet airliner. Similar to the 737 — smooth and stable.',
    model: '/assets/models/a320_v2.glb',
    axis: 'fr24',
    scale: 1.0,
    minimumPixelSize: 80,
    mass: 64000, wingArea: 122, clAlpha: 5.0, cl0: 0.16, clMax: 1.5,
    cd0: 0.019, inducedK: 0.043, maxThrust: 240000,
    flapClBonus: 0.8, flapDrag: 0.035, gearDrag: 0.022,
    rollRate: 1.1, pitchRate: 0.65, yawRate: 0.3,
    wheelHeight: 2.4, stallSpeed: 60, vne: 290,
    span: 35.8, Ixx: 2400000, Iyy: 4500000, Izz: 6700000,
    cockpit: { forward: 16, up: 2.4 }, chase: { back: 75, up: 20 }, propVisual: false,
  },
  b789: {
    id: 'b789',
    name: 'Boeing 787-9 Dreamliner',
    blurb: 'Real long-haul widebody. Big, powerful and serene at altitude.',
    model: '/assets/models/b789_v2.glb',
    axis: 'fr24',
    scale: 1.0,
    minimumPixelSize: 90,
    mass: 200000, wingArea: 360, clAlpha: 4.9, cl0: 0.17, clMax: 1.5,
    cd0: 0.018, inducedK: 0.040, maxThrust: 640000,
    flapClBonus: 0.8, flapDrag: 0.035, gearDrag: 0.02,
    rollRate: 0.9, pitchRate: 0.55, yawRate: 0.25,
    wheelHeight: 3.0, stallSpeed: 68, vne: 295,
    span: 60, Ixx: 11000000, Iyy: 27000000, Izz: 38000000,
    surfaces: {
      // The 787 model only separates some flap panels — animate those.
      flapL: { node: 'lhkflap_001', axis: 'x', pivot: [-9.283, 0.893, -2.722], max: 22, driver: 'flaps', sign: 1 },
      flapR: { node: 'rhkflap_001', axis: 'x', pivot: [8.238, 0.892, -2.715], max: 22, driver: 'flaps', sign: 1 },
    },
    cockpit: { forward: 26, up: 3.2 }, chase: { back: 110, up: 28 }, propVisual: false,
  },
  b744: {
    id: 'b744',
    name: 'Boeing 747-400',
    blurb: 'Real jumbo jet. The queen of the skies — massive and majestic.',
    model: '/assets/models/b744_v2.glb',
    axis: 'fr24',
    scale: 1.0,
    minimumPixelSize: 100,
    mass: 320000, wingArea: 525, clAlpha: 4.8, cl0: 0.18, clMax: 1.5,
    cd0: 0.018, inducedK: 0.038, maxThrust: 1000000,
    flapClBonus: 0.85, flapDrag: 0.04, gearDrag: 0.022,
    rollRate: 0.8, pitchRate: 0.5, yawRate: 0.22,
    wheelHeight: 4.5, stallSpeed: 75, vne: 295,
    span: 64.4, Ixx: 24000000, Iyy: 45000000, Izz: 67000000,
    surfaces: {
      aileronL: { node: 'aileron_left_outer', axis: 'x', pivot: [-24.909, -15.396, 0.495], max: 16, driver: 'roll', sign: 1 },
      aileronR: { node: 'aileron_right_outer', axis: 'x', pivot: [25.046, -15.396, 0.495], max: 16, driver: 'roll', sign: -1 },
      elevatorL: { node: 'elevator_left', axis: 'x', pivot: [-4.868, -37.181, 2.733], max: 16, driver: 'pitch', sign: 1 },
      elevatorR: { node: 'elevator_right', axis: 'x', pivot: [4.988, -37.181, 2.733], max: 16, driver: 'pitch', sign: 1 },
      rudder: { node: 'rudder', axis: 'z', pivot: [36.987, -0.002, 8.887], max: 18, driver: 'yaw', sign: 1 },
    },
    cockpit: { forward: 30, up: 4.5 }, chase: { back: 130, up: 34 }, propVisual: false,
  },
};

// ── Airports & scenic spots ──────────────────────────────────────────────────
// lat/lon in degrees, elev in meters (field elevation), hdg = runway heading (deg).
// airborne:true spawns in flight at the given altitude (m) instead of on a runway.
export const AIRPORTS = [
  { id: 'KIAH', name: 'Houston Intercontinental', lat: 29.9844, lon: -95.3414, elev: 30, hdg: 150 },
  { id: 'KHOU', name: 'Houston Hobby',           lat: 29.6454, lon: -95.2789, elev: 14, hdg: 40 },
  { id: 'KSFO', name: 'San Francisco Intl',      lat: 37.6189, lon: -122.3750, elev: 4,  hdg: 284 },
  { id: 'KLAX', name: 'Los Angeles Intl',        lat: 33.9416, lon: -118.4085, elev: 38, hdg: 250 },
  { id: 'KJFK', name: 'New York JFK',            lat: 40.6413, lon: -73.7781, elev: 4,  hdg: 313 },
  { id: 'KDEN', name: 'Denver (high & thin air)',lat: 39.8561, lon: -104.6737, elev: 1655, hdg: 350 },
  { id: 'KLAS', name: 'Las Vegas Harry Reid',    lat: 36.0840, lon: -115.1537, elev: 664, hdg: 10 },
  { id: 'KSEA', name: 'Seattle-Tacoma',          lat: 47.4502, lon: -122.3088, elev: 131, hdg: 340 },
  { id: 'EGLL', name: 'London Heathrow',         lat: 51.4700, lon: -0.4543, elev: 25, hdg: 270 },
  { id: 'LFPG', name: 'Paris Charles de Gaulle', lat: 49.0097, lon: 2.5479, elev: 119, hdg: 270 },
  { id: 'RJTT', name: 'Tokyo Haneda',            lat: 35.5494, lon: 139.7798, elev: 6, hdg: 340 },
  { id: 'OMDB', name: 'Dubai Intl',              lat: 25.2532, lon: 55.3657, elev: 19, hdg: 300 },
  // Scenic airborne starts — drop in already flying for the views:
  { id: 'GCANYON', name: '✦ Grand Canyon (airborne)', lat: 36.1069, lon: -112.1129, elev: 0, hdg: 90, airborne: 2600 },
  { id: 'EVEREST', name: '✦ Mount Everest (airborne)', lat: 27.9881, lon: 86.9250, elev: 0, hdg: 180, airborne: 9200 },
  { id: 'MANHATTAN', name: '✦ Manhattan (airborne)', lat: 40.7128, lon: -74.0060, elev: 0, hdg: 200, airborne: 1200 },
  { id: 'GGATE', name: '✦ Golden Gate (airborne)', lat: 37.8199, lon: -122.4783, elev: 0, hdg: 320, airborne: 900 },
];

export const airportById = (id) => AIRPORTS.find((a) => a.id === id);

// ── Point-to-point routes (start on the runway at A, fly to B) ────────────────
export const ROUTES = [
  { id: 'IAH-HOU',   from: 'KIAH', to: 'KHOU', name: 'Houston Intl → Hobby',        note: 'short hop ~17 nm' },
  { id: 'LAX-LAS',   from: 'KLAX', to: 'KLAS', name: 'Los Angeles → Las Vegas',     note: '~200 nm over the desert' },
  { id: 'SFO-LAX',   from: 'KSFO', to: 'KLAX', name: 'San Francisco → Los Angeles', note: '~290 nm down the coast' },
  { id: 'SEA-SFO',   from: 'KSEA', to: 'KSFO', name: 'Seattle → San Francisco',     note: '~590 nm' },
  { id: 'EGLL-LFPG', from: 'EGLL', to: 'LFPG', name: 'London → Paris',              note: '~190 nm across the Channel' },
  { id: 'JFK-IAH',   from: 'KJFK', to: 'KIAH', name: 'New York → Houston',          note: 'long haul ~1230 nm' },
];

// ── Keyboard bindings (shown in Controls/Help) ───────────────────────────────
export const KEY_HELP = [
  ['W / S  or  ↑ / ↓', 'Pitch down / up (push / pull)'],
  ['A / D  or  ← / →', 'Roll left / right'],
  ['Q / E', 'Rudder yaw left / right'],
  ['Shift / Ctrl', 'Throttle up / down'],
  ['Z / X', 'Throttle idle / full'],
  ['G', 'Toggle landing gear'],
  ['F / V', 'Flaps down / up'],
  ['B', 'Wheel brakes (hold)'],
  ['Space', 'Toggle parking brake'],
  ['[ / ]', 'Trim nose down / up'],
  ['C', 'Cycle camera (chase / cockpit / orbit / flyby / top)'],
  ['T', 'Toggle wing-leveler autopilot'],
  ['P', 'Toggle instrument panel'],
  ['R', 'Reset to last start point'],
  ['Esc', 'Menu'],
  ['H', 'Help'],
];

// ── Persistent settings helpers ──────────────────────────────────────────────
const LS = 'earthflight.settings.v1';
export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS)) || {}; }
  catch { return {}; }
}
export function saveSettings(s) {
  try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* ignore */ }
}
