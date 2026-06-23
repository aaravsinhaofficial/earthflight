// Central configuration: aircraft, airports, default keys, control bindings.

// ── API keys ────────────────────────────────────────────────────────────────
// Optional. The sim runs with NO keys using free worldwide satellite imagery.
// Users can paste keys in-app (World tab); those are saved to localStorage and
// take precedence over anything here.
export const DEFAULT_ION_TOKEN = '';   // free token from https://cesium.com/ion
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
    cd0: 0.030, inducedK: 0.050, maxThrust: 2600,
    flapClBonus: 0.5, flapDrag: 0.02, gearDrag: 0.0,
    rollRate: 1.8, pitchRate: 1.0, yawRate: 0.6,
    wheelHeight: 1.4, stallSpeed: 27, vne: 92,
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
  ['C', 'Cycle camera (chase / cockpit / orbit / flyby)'],
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
