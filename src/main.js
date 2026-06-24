// EarthFlight — entry point. Boots Cesium, builds the sim, runs the game loop.
import { World } from './world.js';
import { FlightModel } from './flightModel.js';
import { Aircraft } from './aircraft.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Instruments } from './instruments.js';
import { AudioEngine } from './audio.js';
import { Effects } from './effects.js';
import { UI } from './ui.js';
import { AIRCRAFT, AIRPORTS, ROUTES, airportById, DEFAULT_ION_TOKEN, DEFAULT_GOOGLE_KEY, loadSettings, saveSettings } from './config.js';

const PHYS_DT = 1 / 120; // fixed physics timestep

class App {
  constructor() {
    this.settings = loadSettings();
    this.paused = false;
    this.panelOn = true;
    this.lastSpawn = null;
    this.fieldElev = 0;
    this._acc = 0;
    this._last = performance.now();
    this._crashTimer = 0;
    this._crashing = false;
  }

  async init() {
    // First run with a built-in ion token → default to 3D, and reflect it in the
    // World menu so the user doesn't accidentally revert to plain satellite.
    if (!this.settings.worldMode && DEFAULT_ION_TOKEN) {
      this.settings.worldMode = 'ion';
      this.settings.ionToken = this.settings.ionToken || DEFAULT_ION_TOKEN;
    }

    this._setLoading('Spinning up the globe…', 15);
    this.world = new World('cesiumContainer');

    this._setLoading('Streaming terrain & satellite imagery…', 35);
    await this.world.init();

    this._setLoading('Building the aircraft…', 60);
    const acId = (this.settings.aircraft && AIRCRAFT[this.settings.aircraft]) ? this.settings.aircraft : 'pa28';
    this.fm = new FlightModel(AIRCRAFT[acId]);
    this.aircraft = new Aircraft(this.world.scene);
    this.effects = new Effects(this.world.scene);
    await this.aircraft.load(AIRCRAFT[acId]);

    this.cam = new CameraRig(this.world.viewer);
    this.hud = new Hud();
    this.instruments = new Instruments();
    this.audio = new AudioEngine();

    this.input = new Input(this._actions());
    if (this.settings.sensitivity) this.input.sensitivity = this.settings.sensitivity;
    if (this.settings.invertY) this.input.invertY = true;

    this.ui = new UI(this, this.settings);

    // apply saved world look
    if (this.settings.quality) this.world.setQuality(this.settings.quality);
    if (this.settings.time != null) this.world.setTimeOfDay(this.settings.time);

    // start audio on the first user gesture
    const wake = () => { this.audio.start(); window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake); };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);

    // spawn
    const startId = this.settings.lastAirport || 'KIAH';
    const start = AIRPORTS.find(a => a.id === startId) || AIRPORTS[0];
    this.spawnAirport(start);

    this._setLoading('Cleared for takeoff!', 100);
    this.ui.revealHud();
    if (this.panelOn) document.getElementById('panel').classList.remove('hidden');
    setTimeout(() => document.getElementById('loading').classList.add('hidden'), 500);

    // Load the richest world we have keys for. Default to ion (3D terrain + OSM
    // buildings) when a token exists; Google 3D if a Google key is present.
    const ionToken = this.settings.ionToken || DEFAULT_ION_TOKEN;
    const googleKey = this.settings.googleKey || DEFAULT_GOOGLE_KEY;
    const mode = this.settings.worldMode || (googleKey ? 'google' : ionToken ? 'ion' : 'satellite');
    if (mode !== 'satellite' && (ionToken || googleKey)) {
      this._setLoading('Loading 3D terrain & buildings…', 100);
      this.applyWorld(mode, { ionToken, googleKey })
        .then((m) => this._toast(m === 'ion' ? '🏙 3D terrain + buildings on' : m === 'google' ? '🌍 Google 3D on' : ''))
        .catch(() => {});
    }

    // drive everything from Cesium's render loop
    this.world.scene.preUpdate.addEventListener(() => this.frame());

    // first help nudge for new users
    if (!this.settings.seen) { this.ui.toggleHelp(); this.settings.seen = true; saveSettings(this.settings); }
  }

  _actions() {
    return {
      onGear: () => this.fm.toggleGear(),
      onFlaps: (d) => this.fm.addFlaps(d * 0.34),
      onParking: () => this.fm.toggleParking(),
      onTrim: (d) => this.fm.addTrim(d),
      onThrottleSet: (v) => this.fm.setThrottle(v),
      onCamera: () => this.cycleCamera(),
      onAutopilot: () => this.fm.toggleAP(),
      onPanel: () => this.togglePanel(),
      onReset: () => this.resetPosition(),
      onMenu: () => this.ui.toggleMenu(),
      onHelp: () => this.ui.toggleHelp(),
      onBrake: (b) => { this.fm.wheelBrake = b; },
    };
  }

  // ── main frame ──────────────────────────────────────────────────────────
  frame() {
    const now = performance.now();
    let dt = (now - this._last) / 1000;
    this._last = now;
    dt = Math.min(dt, 0.1);

    this.input.update(dt);
    if (this.input.throttleDelta) this.fm.addThrottle(this.input.throttleDelta);
    const controls = this.input.getControls();

    if (!this.paused) {
      const c = this.fm.cartographicDeg;
      let ground;
      if (this.runway) {
        // Lock the runway to a single flat elevation, converged from terrain at
        // the (fixed) spawn point so it matches the scenery without bouncing.
        const sampled = this.world.sampleGround(this.runway.lon, this.runway.lat, this.runway.elev);
        this.runway.elev = this.runway.elev * 0.9 + sampled * 0.1;
        const dN = (c.lat - this.runway.lat) * 111320;
        const dE = (c.lon - this.runway.lon) * 111320 * Math.cos(this.runway.lat * Math.PI / 180);
        if (Math.hypot(dN, dE) < 5000) ground = this.runway.elev;     // flat runway zone
        else { this.runway = null; ground = this.world.sampleGround(c.lon, c.lat, this.fieldElev); }
      } else {
        ground = this.world.sampleGround(c.lon, c.lat, this.fieldElev);
      }
      const env = { terrainHeight: ground };

      this._acc += dt;
      let steps = 0;
      while (this._acc >= PHYS_DT && steps < 8) {
        this.fm.update(PHYS_DT, controls, env);
        this._acc -= PHYS_DT;
        steps++;
      }

      if (this.fm.crashed && !this._crashing) this._handleCrash();
    }

    this.aircraft.update(this.fm);
    this.aircraft.setVisible(!this._crashing && this.cam.mode !== 'cockpit');
    this.cam.update(dt, this.aircraft, this.fm);
    this.hud.update(this.fm, this.cam.modeLabel, dt);
    if (this.destination) {
      const di = this._destInfo();
      this.hud.updateDest(this.destination.name, di.nm, di.bearing);
      if (!this._arrived && di.km < 8 && this.fm.agl < 1500) {
        this._arrived = true;
        this._toast(`🛬 Arrived at ${this.destination.name}! Nice flying.`);
      }
    } else {
      this.hud.updateDest(null);
    }
    this.instruments.update(this.fm);
    this.audio.update(this.fm);
    this.effects.update(dt);
  }

  // Crash → fireball at the wreck, freeze, then force a reset.
  _handleCrash() {
    this._crashing = true;
    this.fm.crashed = false;
    const size = Math.max(5, Math.cbrt(this.fm.ac.mass) * 0.5);
    this.effects.explode(this.aircraft.position, size);
    this.aircraft.setVisible(false);
    this.audio.update?.(this.fm);
    this._banner('💥 CRASHED', 'resetting…');
    this.paused = true;
    setTimeout(() => {
      this.resetPosition();
      this.paused = false;
      this._crashing = false;
      this._banner();
    }, 3000);
  }

  _banner(title, sub) {
    let el = document.getElementById('crashBanner');
    if (!title) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'crashBanner'; document.body.appendChild(el); }
    el.innerHTML = `<div class="cb-title">${title}</div><div class="cb-sub">${sub || ''}</div>`;
  }

  // ── commands from UI/input ───────────────────────────────────────────────
  spawnAirport(ap) {
    this.lastSpawn = ap;
    this.fieldElev = ap.airborne ? ap.airborne - 500 : ap.elev;
    this.fm.reset({
      lon: ap.lon, lat: ap.lat,
      height: ap.airborne ? ap.airborne : ap.elev,
      heading: ap.hdg, airborne: ap.airborne,
    });
    this.world.resetGroundSample(ap.airborne ? null : ap.elev);
    this.destination = null; this.world.hideRoute(); // clear any active route (setRoute re-adds after)
    if (ap.airborne) { this.world.hideRunway(); this.runway = null; }
    else {
      this.world.showRunway(ap.lon, ap.lat, ap.hdg);
      // A flat runway zone: ground contact uses ONE locked elevation near the
      // airport instead of bumpy per-point terrain, so takeoff is smooth and the
      // plane isn't shoved around or forced back down while climbing out.
      this.runway = { lon: ap.lon, lat: ap.lat, elev: ap.elev };
    }
    this.cam.smoothEye = null;
    this.settings.lastAirport = ap.id; saveSettings(this.settings);
    this._toast(`📍 ${ap.name}`);
  }

  setRoute(route) {
    const from = airportById(route.from), to = airportById(route.to);
    if (!from || !to) return;
    this.spawnAirport(from);                 // spawn on the origin runway (clears old route)
    this.destination = { name: to.name, lat: to.lat, lon: to.lon, elev: to.elev };
    this._arrived = false;
    this.world.showRoute(from.lat, from.lon, to.lat, to.lon, to.name);
    this._toast(`🧭 ${route.name} — fly to ${to.name}`);
  }

  // distance (nm) + bearing (deg) from the aircraft to the destination
  _destInfo() {
    const c = this.fm.cartographicDeg, d = this.destination;
    const D = Math.PI / 180;
    const φ1 = c.lat * D, φ2 = d.lat * D, dφ = (d.lat - c.lat) * D, dλ = (d.lon - c.lon) * D;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const y = Math.sin(dλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
    const brg = ((Math.atan2(y, x) / D) + 360) % 360;
    return { km, nm: km * 0.539957, bearing: brg };
  }

  gotoLocation(lat, lon, height) {
    const ap = { id: 'CUSTOM', name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon, hdg: 90, airborne: height || 2500 };
    this.spawnAirport(ap);
  }

  resetPosition() { if (this.lastSpawn) this.spawnAirport(this.lastSpawn); }

  async setAircraft(id) {
    if (!AIRCRAFT[id]) return;
    this.settings.aircraft = id; saveSettings(this.settings);
    this.fm.setAircraft(AIRCRAFT[id]);
    await this.aircraft.load(AIRCRAFT[id]);
    if (this.lastSpawn) this.spawnAirport(this.lastSpawn);
    this._toast(`✈ ${AIRCRAFT[id].name}`);
  }

  async applyWorld(mode, keys) {
    const applied = await this.world.applyWorld(mode, keys);
    if (this.settings.quality) this.world.setQuality(this.settings.quality);
    if (this.settings.time != null) this.world.setTimeOfDay(this.settings.time);
    this.world.resetGroundSample(this.lastSpawn?.airborne ? null : this.fieldElev);
    return applied;
  }

  setTimeOfDay(h) { this.world.setTimeOfDay(h); }
  setQuality(q) { this.world.setQuality(q); }
  setSensitivity(v) { this.input.sensitivity = v; }
  setInvertY(b) { this.input.invertY = b; }
  cycleCamera() { this.cam.cycle(); }
  togglePause() {
    this.paused = !this.paused;
    document.getElementById('btnPause').textContent = this.paused ? '▶ Resume' : '⏸ Pause';
    this._toast(this.paused ? '⏸ Paused' : '▶ Flying');
  }
  togglePanel() {
    this.panelOn = !this.panelOn;
    document.getElementById('panel').classList.toggle('hidden', !this.panelOn);
  }

  // ── small helpers ────────────────────────────────────────────────────────
  _setLoading(text, pct) {
    const t = document.getElementById('loadingText');
    const b = document.getElementById('loadingBar');
    if (t) t.textContent = text;
    if (b) b.style.width = pct + '%';
  }

  _toast(msg) {
    let host = document.getElementById('toast');
    if (!host) { host = document.createElement('div'); host.id = 'toast'; document.body.appendChild(host); }
    const d = document.createElement('div'); d.className = 'toast-item'; d.textContent = msg;
    host.appendChild(d);
    setTimeout(() => d.classList.add('show'), 10);
    setTimeout(() => { d.classList.remove('show'); setTimeout(() => d.remove(), 400); }, 2200);
  }
}

const app = new App();
app.init().catch((e) => {
  console.error(e);
  const t = document.getElementById('loadingText');
  if (t) t.textContent = 'Failed to start: ' + (e?.message || e);
});
window.app = app; // handy for debugging in the console
