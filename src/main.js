// EarthFlight — entry point. Boots Cesium, builds the sim, runs the game loop.
import * as Cesium from 'cesium';
import { World } from './world.js';
import { FlightModel } from './flightModel.js';
import { Aircraft } from './aircraft.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Instruments } from './instruments.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';
import { AIRCRAFT, AIRPORTS, loadSettings, saveSettings } from './config.js';

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
  }

  async init() {
    this._setLoading('Spinning up the globe…', 15);
    this.world = new World('cesiumContainer');

    this._setLoading('Streaming terrain & satellite imagery…', 35);
    await this.world.init();

    this._setLoading('Building the aircraft…', 60);
    const acId = (this.settings.aircraft && AIRCRAFT[this.settings.aircraft]) ? this.settings.aircraft : 'pa28';
    this.fm = new FlightModel(AIRCRAFT[acId]);
    this.aircraft = new Aircraft(this.world.scene);
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

    // restore a richer world if the user had keys saved
    const mode = this.settings.worldMode;
    if (mode && mode !== 'satellite' && (this.settings.ionToken || this.settings.googleKey)) {
      this.applyWorld(mode, { ionToken: this.settings.ionToken, googleKey: this.settings.googleKey })
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
      const ground = this.world.sampleGround(c.lon, c.lat, this.fieldElev);
      const env = { terrainHeight: ground };

      this._acc += dt;
      let steps = 0;
      while (this._acc >= PHYS_DT && steps < 8) {
        this.fm.update(PHYS_DT, controls, env);
        this._acc -= PHYS_DT;
        steps++;
      }

      if (this.fm.crashed) this._handleCrash();
    }

    this.aircraft.update(this.fm);
    this.aircraft.setVisible(this.cam.mode !== 'cockpit');
    this.cam.update(dt, this.aircraft, this.fm);
    this.hud.update(this.fm, this.cam.modeLabel, dt);
    this.instruments.update(this.fm);
    this.audio.update(this.fm);
  }

  _handleCrash() {
    this.fm.crashed = false;
    if (this.fm.verticalSpeed < -12 || this.fm.V > this.fm.ac.vne) {
      this._toast('💥 Hard crash — respawning at start');
      this.resetPosition();
    } else {
      // firm but survivable: just kill vertical energy
      this.fm.verticalSpeed = 0;
    }
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
    if (ap.airborne) this.world.hideRunway();
    else this.world.showRunway(ap.lon, ap.lat, ap.hdg);
    this.cam.smoothEye = null;
    this.settings.lastAirport = ap.id; saveSettings(this.settings);
    this._toast(`📍 ${ap.name}`);
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
window.Cesium = Cesium;
