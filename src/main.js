// EarthFlight — entry point. Boots Cesium, builds the sim, runs the game loop.
import { World } from './world.js';
import { FlightModel } from './flightModel.js';
import { Aircraft } from './aircraft.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { FlightHud } from './flighthud.js';
import { Instruments } from './instruments.js';
import { AudioEngine } from './audio.js';
import { Effects } from './effects.js';
import { UI } from './ui.js';
import { clamp, wrapPi, wrap360, airDensity, DEG } from './util.js';
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
    this.landingArmed = false;  // 'L' arms the MSFS-style landing scorer
    // autopilot: a Set of active modes (HDG/NAV/ALT/SPD) + their targets
    this.ap = { on: false, modes: new Set(), targetHdg: 0, targetAlt: 0, targetIAS: 0, iThr: 0 };
  }

  async init() {
    // Default to PHOTOREALISTIC Google 3D tiles (real textured buildings), routed
    // through the bundled ion token — no Google key required. A one-time migration
    // bumps anyone still on the old 'ion' OSM-blocks default up to photorealistic.
    if (DEFAULT_ION_TOKEN || DEFAULT_GOOGLE_KEY) {
      this.settings.ionToken = this.settings.ionToken || DEFAULT_ION_TOKEN;
      if (!this.settings.photorealMigrated) {
        if (!this.settings.worldMode || this.settings.worldMode === 'ion') this.settings.worldMode = 'google';
        this.settings.photorealMigrated = true;
        saveSettings(this.settings);
      }
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
    this.flightHud = new FlightHud();
    this.instruments = new Instruments();
    this.audio = new AudioEngine();
    if (this.settings.volume != null) this.audio.setVolume(this.settings.volume);

    this.input = new Input(this._actions());
    if (this.settings.sensitivity) this.input.sensitivity = this.settings.sensitivity;
    if (this.settings.invertY) this.input.invertY = true;

    this.ui = new UI(this, this.settings);

    // if photoreal tiles can't load (ion token over quota / unauthorized), the
    // World layer falls back on its own — persist + reflect that so reloads don't
    // keep re-attempting the broken mode, and tell the user.
    this.world.onModeFallback = (applied, reason) => {
      this.settings.worldMode = applied; saveSettings(this.settings);
      this.ui?.syncWorldMode?.(applied);
      this._toast(applied === 'ion'
        ? '⚠ Photorealistic 3D unavailable — using 3D blocks (OSM)'
        : '⚠ Photorealistic 3D unavailable — using satellite');
    };

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

    // Load the richest world we have keys for. Photorealistic Google 3D by default
    // (via the bundled ion token); falls back automatically if it can't load.
    const ionToken = this.settings.ionToken || DEFAULT_ION_TOKEN;
    const googleKey = this.settings.googleKey || DEFAULT_GOOGLE_KEY;
    const mode = this.settings.worldMode || ((ionToken || googleKey) ? 'google' : 'satellite');
    if (mode !== 'satellite' && (ionToken || googleKey)) {
      this._setLoading('Loading 3D terrain & buildings…', 100);
      this.applyWorld(mode, { ionToken, googleKey })
        .then((m) => {
          // if it fell back to something else, remember that so we don't retry on reload
          if (m !== mode) { this.settings.worldMode = m; saveSettings(this.settings); this.ui?.syncWorldMode?.(m); }
          this._toast(m === 'ion' ? '🏙 3D terrain + OSM buildings on' : m === 'google' ? '🌆 Photorealistic 3D buildings on' : '');
        })
        .catch(() => {});
    }

    // drive everything from Cesium's render loop
    this.world.scene.preUpdate.addEventListener(() => this.frame());

    // first help nudge for new users
    if (!this.settings.seen) { this.ui.toggleHelp(); this.settings.seen = true; saveSettings(this.settings); }
  }

  _actions() {
    return {
      onGear: () => {
        if (this.fm.fixedGear) { this._toast('Fixed gear — not retractable'); return; }
        if (this.fm.onGround) { this._toast('Gear locked on the ground'); return; }
        this.fm.toggleGear();
        const over = this.fm.V > this.fm.gearVlo;
        this._toast(this.fm.gearDown
          ? (over ? '⚠ GEAR DOWN — above limit speed' : '⬇ Gear down')
          : (over ? '⚠ GEAR UP — above limit speed' : '⬆ Gear up'));
      },
      onFlaps: (d) => {
        const before = this.fm.flapLabel;
        const label = this.fm.addFlaps(d);
        if (label === before) { this._toast(d > 0 ? 'Flaps already FULL' : 'Flaps already up'); return; }
        const over = this.fm.V > this.fm.flapVfe();
        this._toast(over ? `⚠ FLAPS ${label} — above limit speed` : `Flaps ${label}`);
      },
      onParking: () => this.fm.toggleParking(),
      onTrim: (d) => this.fm.addTrim(d),
      onThrottleSet: (v) => this.fm.setThrottle(v),
      onCamera: () => this.cycleCamera(),
      onAutopilot: () => this._apCycleMaster(),
      onApNav: () => this._apToggleMode('NAV'),
      onApSpd: () => this._apToggleMode('SPD'),
      onApSync: () => { this.ap.targetHdg = this.fm.heading; this.ap.modes.add('HDG'); this.ap.modes.delete('NAV'); this._apEnsureOn(); this._toast('AP HDG synced'); },
      onApAlt: (d) => { this.ap.targetAlt = clamp(this.ap.targetAlt + d * 100 / 3.280839895, this.fieldElev, 14000); this.ap.modes.add('ALT'); this._apEnsureOn(); this._toast(`AP ALT ${Math.round(this.ap.targetAlt * 3.28084)} ft`); },
      onApHdg: (d) => { this.ap.targetHdg = wrapPi(this.ap.targetHdg + d * 5 * DEG); this.ap.modes.add('HDG'); this.ap.modes.delete('NAV'); this._apEnsureOn(); this._toast(`AP HDG ${String(Math.round(wrap360(this.ap.targetHdg / DEG))).padStart(3, '0')}`); },
      onPanel: () => this.togglePanel(),
      onReset: () => this.resetPosition(),
      onMenu: () => this.ui.toggleMenu(),
      onHelp: () => this.ui.toggleHelp(),
      onBrake: (b) => { this.fm.wheelBrake = b; },
      onLandingMode: () => this.toggleLandingMode(),
    };
  }

  // ── main frame ──────────────────────────────────────────────────────────
  frame() {
    const now = performance.now();
    let dt = (now - this._last) / 1000;
    this._last = now;
    dt = Math.min(dt, 0.1);

    this.world.onFrame();   // render-error decay / quality recovery
    this.world.updateGroundSharpness(this.fm.agl, dt, now); // sharpen photoreal tiles near the ground

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
        this.world.alignRunwayLights(this.runway.elev);  // keep lights on the real ground
        const dN = (c.lat - this.runway.lat) * 111320;
        const dE = (c.lon - this.runway.lon) * 111320 * Math.cos(this.runway.lat * Math.PI / 180);
        if (Math.hypot(dN, dE) < 5000) ground = this.runway.elev;     // flat runway zone
        else { this.runway = null; ground = this.world.sampleGround(c.lon, c.lat, this.fieldElev); }
      } else {
        ground = this.world.sampleGround(c.lon, c.lat, this.fieldElev);
      }
      const env = { terrainHeight: ground };

      this._autopilot(controls, dt);   // AP overwrites controls before the substeps fly them

      this._acc += dt;
      let steps = 0;
      while (this._acc >= PHYS_DT && steps < 8) {
        this.fm.update(PHYS_DT, controls, env);
        this._acc -= PHYS_DT;
        steps++;
      }

      // landing scorer: the flight model raises justLanded once when the wheels
      // settle. Score it (when armed) — but never when it was also a crash.
      if (this.fm.justLanded) {
        this.fm.justLanded = false;
        if (this.landingArmed && !this._crashing && !this.fm.crashed && this.fm.lastTouchdown) {
          this._scoreLanding(this.fm.lastTouchdown);
        }
      }

      // collision with 3D structures (buildings / Google-tile geometry): if the
      // rendered surface under us is well above the terrain and we're below its
      // top, we've flown into a building. Skip on short final / in the flat runway
      // zone, where terminal & jet-bridge geometry would false-trigger a crash.
      if (!this.fm.onGround && !this._crashing && !this.runway && this.fm.agl > 45 && this.fm.agl < 800) {
        const sh = this.world.sampleSceneHeight(c.lon, c.lat, this.aircraft.model);
        if (sh != null && this.fm.height < sh - 1 && sh > this.fm.terrainHeight + 8) this.fm.crashed = true;
      }
      if (this.fm.crashed && !this._crashing) this._handleCrash();

      // refresh real weather when you fly into a new area (~40 km)
      if (this.weather && this._weatherAt) {
        const wN = (c.lat - this._weatherAt.lat) * 111320;
        const wE = (c.lon - this._weatherAt.lon) * 111320 * Math.cos(c.lat * Math.PI / 180);
        if (Math.hypot(wN, wE) > 40000) this.fetchWeather(c.lat, c.lon);
      }
    }

    // day/night: real sun elevation at the aircraft → auto lights + world dimming
    const nf = this.world.nightFactor(this.fm.lon, this.fm.lat, now);
    const isNight = nf > 0.02;
    this.fm.onRunwayActive = this.fm.onGround && !!this.runway && (this.fm.throttle > 0.25 || this.fm.V > 2.0);
    if (isNight !== this._wasNight) { this._wasNight = isNight; this.world.setRunwayLightsVisible(isNight); }

    this.aircraft.update(this.fm, dt, isNight);
    const inside = this.cam.mode === 'cockpit' || this.cam.mode === 'hud';
    this.aircraft.setVisible(!this._crashing && !inside);
    this.cam.update(dt, this.aircraft, this.fm);

    // view-dependent overlays: HUD symbology / 2D cockpit frame
    document.body.classList.toggle('view-hud', this.cam.mode === 'hud');
    document.body.classList.toggle('view-cockpit', this.cam.mode === 'cockpit');
    this.flightHud.setVisible(this.cam.mode === 'hud');
    if (this.cam.mode === 'hud') {
      const fovy = (this.world.camera.frustum.fovy || 0.87) * 180 / Math.PI;
      this.flightHud.update(this.fm, fovy);
    }
    this.hud.update(this.fm, this.cam.modeLabel, dt, this.ap);
    // live approach readout while the landing scorer is armed (under ~1000 ft AGL)
    this._landReadout(this.landingArmed && !this.fm.onGround && this.fm.agl < 305 && !this._crashing);
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
    this.audio.update(this.fm, dt);
    this.effects.update(dt);
  }

  // ── AUTOPILOT ────────────────────────────────────────────────────────────
  // Writes controls.{roll,pitch,yaw} in place (and may set throttle) each frame,
  // BEFORE the physics substeps, so all 8 substeps fly the AP commands. Cascaded
  // loops: heading→bank→aileron, altitude→VS→pitch attitude→elevator.
  _autopilot(controls, dtFrame) {
    const ap = this.ap, fm = this.fm;
    if (!ap.on || fm.onGround || fm.crashed) return;

    // manual override: if the pilot grabs the stick, hand the plane back
    const stick = Math.max(Math.abs(controls.pitch), Math.abs(controls.roll), Math.abs(controls.yaw));
    if (stick > 0.5) { this._apDisengage('AP OFF — manual override'); return; }

    // authority normalizer — cancels the qbar·V² scaling so the loops behave the
    // same slow or fast (gains are then aircraft-independent via stallSpeed)
    const Vref = 1.6 * fm.ac.stallSpeed;
    const qRef = 0.5 * 1.225 * Vref * Vref;
    const qbar = 0.5 * airDensity(fm.height) * fm.V * fm.V;
    const qScale = clamp(qRef / Math.max(qbar, 1e3), 0.35, 3.0);

    // NAV: steer the great-circle bearing to the destination
    if (ap.modes.has('NAV') && this.destination) {
      const di = this._destInfo();
      if (di.km < 1.0) { ap.modes.delete('NAV'); ap.modes.add('HDG'); ap.targetHdg = fm.heading; this._toast(`Overhead ${this.destination.name} — NAV → HDG`); }
      else ap.targetHdg = di.bearing * DEG;
    }

    // LATERAL: heading → bank → aileron (+ coordinated rudder / yaw damper)
    if (ap.modes.has('HDG') || ap.modes.has('NAV')) {
      const hdgErr = wrapPi(ap.targetHdg - fm.heading);
      const bankCmd = clamp(1.3 * hdgErr, -25 * DEG, 25 * DEG);
      const rollOut = 1.8 * (bankCmd - fm.roll) - 0.30 * fm.p;
      controls.roll = clamp(qScale * rollOut, -1, 1);
      controls.yaw = clamp(qScale * (0.5 * bankCmd - 0.8 * fm.r), -0.5, 0.5);
    }

    // VERTICAL: altitude → VS (soft capture) → pitch attitude → elevator
    if (ap.modes.has('ALT')) {
      const altErr = ap.targetAlt - fm.height;
      let vsCmd = clamp(0.10 * altErr, -5, 5);
      const cb = 60;
      if (Math.abs(altErr) < cb) { const lim = 5 * Math.abs(altErr) / cb + 0.2; vsCmd = clamp(vsCmd, -lim, lim); }
      const vsErr = vsCmd - fm.verticalSpeed;
      const pitchTgt = clamp(0.020 * vsErr, -12 * DEG, 12 * DEG);
      const pitchOut = 1.6 * (pitchTgt - fm.pitch) - 0.8 * fm.q_rate;
      controls.pitch = clamp(qScale * pitchOut, -1, 1);
      // slow auto-trim follow-up — offloads the steady elevator to trim (what a real
      // AP's trim does) so there's no steady-state error; frozen when the elevator
      // saturates (anti-windup) → stable climbs/holds across the whole fleet.
      if (Math.abs(controls.pitch) < 0.98) fm.trim = clamp(fm.trim + 0.012 * (pitchTgt - fm.pitch), -0.6, 0.6);
    }

    // AUTOTHROTTLE: hold indicated airspeed (PI with anti-windup)
    if (ap.modes.has('SPD')) {
      const e = ap.targetIAS - fm.ias;
      ap.iThr = clamp(ap.iThr + 0.05 * e * dtFrame, -0.5, 0.5);
      fm.setThrottle(clamp(fm.throttle + 0.012 * e + ap.iThr, 0, 1));
    }
  }

  _apEngage() {
    const fm = this.fm;
    this.ap.on = true; this.ap.iThr = 0;
    this.ap.targetHdg = fm.heading;
    this.ap.targetAlt = Math.round(fm.height / 10) * 10;
    this.ap.targetIAS = fm.ias;
    fm.autopilotLevel = false;   // the new AP owns roll — disable the built-in leveler
  }
  _apEnsureOn() { if (!this.ap.on) this._apEngage(); this._apPill(); }
  _apDisengage(msg) {
    this.ap.on = false; this.ap.modes.clear(); this.fm.autopilotLevel = false;
    if (msg) this._toast(msg); this._apPill();
  }
  // 't' cascade: OFF → WINGS (built-in leveler) → full AP (HDG+ALT) → OFF
  _apCycleMaster() {
    const fm = this.fm;
    if (!this.ap.on && !fm.autopilotLevel) { fm.toggleAP(); this._toast('AP WINGS — roll level'); }
    else if (fm.autopilotLevel && !this.ap.on) { fm.autopilotLevel = false; this._apEngage(); this.ap.modes.add('HDG'); this.ap.modes.add('ALT'); this._toast('AP HDG·ALT engaged'); }
    else { this._apDisengage('AP OFF'); return; }
    this._apPill();
  }
  _apToggleMode(m) {
    if (m === 'NAV' && !this.destination) { this._toast('No destination set (pick a route)'); return; }
    this._apEnsureOn();
    if (this.ap.modes.has(m)) {
      this.ap.modes.delete(m);
      if (this.ap.modes.size === 0) this._apDisengage('AP OFF');
    } else {
      if (m === 'NAV') { this.ap.modes.delete('HDG'); this.ap.modes.add('ALT'); }
      if (m === 'SPD') this.ap.targetIAS = this.fm.ias;
      this.ap.modes.add(m);
    }
    this._apPill();
  }
  _apPill() { /* HUD reads app.ap each frame; nothing to push here */ }

  // Crash → fireball at the wreck, freeze, then force a reset.
  _handleCrash() {
    this._crashing = true;
    this.fm.crashed = false;
    this._apDisengage();
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

  // ── landing scorer (MSFS-style) ──────────────────────────────────────────
  toggleLandingMode() {
    this.landingArmed = !this.landingArmed;
    const pill = document.getElementById('landPill');
    if (pill) { pill.textContent = this.landingArmed ? 'LAND ⏺' : 'LAND OFF'; pill.classList.toggle('pill-on', this.landingArmed); }
    if (this.landingArmed) { this.fm.lastTouchdown = null; this.fm.justLanded = false; this._scorecard(null); }
    else this._landReadout(false);
    this._toast(this.landingArmed
      ? '🛬 Landing mode ARMED — fly a smooth approach, I\'ll score the touchdown'
      : 'Landing scorer off');
  }

  // Score a touchdown 0–100 from its captured metrics. Smoothness (sink rate)
  // dominates, matching every community landing-rate monitor; bank, approach
  // speed, crab and bounces round it out, with real "inspection" hard caps.
  _scoreLanding(td) {
    const fpm = Math.abs(td.fpm);
    // vertical speed (smoothness) — the headline metric, 55 pts
    let vs;
    if (fpm <= 60) vs = 1; else if (fpm <= 120) vs = 0.9; else if (fpm <= 200) vs = 0.75;
    else if (fpm <= 300) vs = 0.55; else if (fpm <= 400) vs = 0.3; else if (fpm <= 600) vs = 0.1; else vs = 0;
    // bank angle at touchdown — wingtip-strike risk, 15 pts
    const bank = clamp(1 - Math.pow(td.bankDeg / 8, 1.3), 0, 1);
    // approach speed vs stall (target ≈ 1.15–1.45 × Vstall ≈ Vref), 12 pts
    const vr = td.vKt / (td.vStall * 1.943844);
    let spd;
    if (vr >= 1.15 && vr <= 1.45) spd = 1; else if (vr < 1.05) spd = 0.2;
    else if (vr < 1.15) spd = 0.6; else if (vr <= 1.6) spd = 0.6; else spd = 0.35;
    // crab / sideslip — side-load on the gear, 10 pts
    const crab = clamp(1 - Math.pow(td.crabDeg / 8, 1.2), 0, 1);
    // bounces, 8 pts
    const bnc = td.bounces || 0;
    const bounce = bnc === 0 ? 1 : bnc === 1 ? 0.55 : bnc === 2 ? 0.25 : 0;

    let score = 55 * vs + 15 * bank + 12 * spd + 10 * crab + 8 * bounce;
    const tags = [];
    // structural cap on sink rate (G is weight-dependent → kept as a display value)
    if (fpm > 600) { score = Math.min(score, 25); tags.push('structural'); }
    if (bnc >= 3) { score = Math.min(score, 40); tags.push('porpoised'); }
    if (vr < 1.05) { score = Math.min(score, 50); tags.push('near-stall'); }
    if (!td.gearDown) { score = Math.min(score, 30); tags.push('gear-up!'); }
    score = Math.round(clamp(score, 0, 100));

    const g = score >= 95 ? ['BUTTER', '#54ffb0'] : score >= 88 ? ['GREASER', '#54ffb0']
      : score >= 80 ? ['SMOOTH', '#7be0ff'] : score >= 70 ? ['GOOD', '#7be0ff']
      : score >= 60 ? ['FIRM', '#ffd479'] : score >= 45 ? ['HARD', '#ff9a3c']
      : score >= 25 ? ['VERY HARD', '#ff5a3c'] : ['CRUNCH', '#ff5a3c'];

    this._scorecard({ score, word: g[0], color: g[1], fpm: Math.round(fpm), td, tags });
    this._toast(`🛬 ${g[0]} — ${score}/100 (${Math.round(fpm)} fpm)`);
    this._landReadout(false);
  }

  _scorecard(data) {
    let el = document.getElementById('landingCard');
    if (!data) { if (el) el.remove(); if (this._cardTimer) clearTimeout(this._cardTimer); return; }
    if (!el) { el = document.createElement('div'); el.id = 'landingCard'; document.body.appendChild(el); }
    const td = data.td;
    const row = (label, val, unit = '') => `<div class="lc-row"><span>${label}</span><b>${val}</b><span class="lc-u">${unit}</span></div>`;
    el.innerHTML = `
      <div class="lc-card" style="--lc:${data.color}">
        <div class="lc-grade">${data.word}</div>
        <div class="lc-score">${data.score}<span>/100</span></div>
        <div class="lc-bar"><div class="lc-fill" style="width:${data.score}%"></div></div>
        <div class="lc-rows">
          ${row('Sink rate', data.fpm, 'fpm')}
          ${row('Touchdown G', td.g.toFixed(2), 'g')}
          ${row('Bank', td.bankDeg.toFixed(1), '°')}
          ${row('Approach', (td.vKt).toFixed(0), 'kt')}
          ${row('Crab', td.crabDeg.toFixed(1), '°')}
          ${row('Bounces', td.bounces, '')}
        </div>
        ${data.tags.length ? `<div class="lc-tags">⚠ ${data.tags.join(' · ')}</div>` : ''}
        <div class="lc-hint">press L to re-arm</div>
      </div>`;
    if (this._cardTimer) clearTimeout(this._cardTimer);
    this._cardTimer = setTimeout(() => this._scorecard(null), 9000);
  }

  _landReadout(show) {
    let el = document.getElementById('landReadout');
    if (!show) { if (el) el.classList.add('hidden'); return; }
    if (!el) { el = document.createElement('div'); el.id = 'landReadout'; el.className = 'land-readout'; document.body.appendChild(el); }
    el.classList.remove('hidden');
    const fm = this.fm;
    const fpm = Math.round(Math.abs(fm.verticalSpeed) * 196.8503937);
    const vref = fm.V / fm.ac.stallSpeed;
    const bank = Math.abs(fm.roll) * 180 / Math.PI;
    const sinkCls = fpm > 600 ? 'bad' : fpm > 300 ? 'warn' : 'good';
    el.innerHTML = `🛬 ARMED &nbsp; SINK <b class="${sinkCls}">${fpm}</b> fpm &nbsp; ` +
      `VREF <b>${vref.toFixed(2)}</b> &nbsp; BANK <b>${bank.toFixed(0)}°</b>`;
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
    // No drawn runway — you start on the real runway in the imagery. We still lock
    // a flat ground elevation near the airport so takeoff is smooth (terrain noise
    // can't bounce the plane), but nothing is painted on top.
    this.runway = ap.airborne ? null : { lon: ap.lon, lat: ap.lat, elev: ap.elev };
    if (!ap.airborne) this.world.buildRunwayLights(ap.lon, ap.lat, ap.hdg, ap.elev); else this.world.hideRunwayLights();
    this._wasNight = undefined; // re-evaluate runway-light visibility next frame
    this.cam.smoothEye = null;
    this.fetchWeather(ap.lat, ap.lon);
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

  // ── real weather (Open-Meteo, free, no key) ──────────────────────────────
  async fetchWeather(lat, lon) {
    if (this.settings.realWeather === false) { this.fm.wind = { n: 0, e: 0, d: 0 }; this.world.applyWeather({ code: 0, cloud: 0 }); return; }
    this._weatherAt = { lat, lon };
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
        + `&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,cloud_cover`
        + `&wind_speed_unit=ms&timezone=auto`;
      const r = await fetch(url);
      const j = await r.json();
      if (!j.current) return;
      const c = j.current;
      const t = c.time || '';
      const localHour = t.length >= 16 ? parseInt(t.slice(11, 13)) + parseInt(t.slice(14, 16)) / 60 : null;
      this.weather = {
        temp: c.temperature_2m, windSpeed: Math.min(c.wind_speed_10m || 0, 18),
        windDir: c.wind_direction_10m || 0, gust: c.wind_gusts_10m || 0,
        code: c.weather_code || 0, cloud: c.cloud_cover || 0, localHour,
      };
      this.applyWeather();
    } catch { /* offline → calm, clear */ }
  }

  applyWeather() {
    const w = this.weather; if (!w) return;
    const toBear = (w.windDir + 180) * Math.PI / 180;   // air moves toward (from + 180°)
    this.fm.wind = { n: w.windSpeed * Math.cos(toBear), e: w.windSpeed * Math.sin(toBear), d: 0 };
    this.world.applyWeather(w);
    this.ui.showWeather(w);
    // match the lighting to the real local solar time at this location
    if (w.localHour != null && this._weatherAt) {
      const utch = (((w.localHour - this._weatherAt.lon / 15) % 24) + 24) % 24;
      this.world.setTimeOfDay(utch);
      this.ui.syncTime(utch, w.localHour);
    }
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

  resetPosition() { this._apDisengage(); if (this.lastSpawn) this.spawnAirport(this.lastSpawn); }

  async setAircraft(id) {
    if (!AIRCRAFT[id]) return;
    this.settings.aircraft = id; saveSettings(this.settings);
    this.fm.setAircraft(AIRCRAFT[id]);
    await this.aircraft.load(AIRCRAFT[id]);
    if (this.lastSpawn) this.spawnAirport(this.lastSpawn);
    this._toast(`✈ ${AIRCRAFT[id].name}`);
  }

  async applyWorld(mode, keys) {
    // Always fall back to the bundled token/key if a field is blank, so an empty
    // input never silently strands the user on a keyless (no-buildings) world.
    keys = keys || {};
    const ionToken = keys.ionToken || this.settings.ionToken || DEFAULT_ION_TOKEN;
    const googleKey = keys.googleKey || this.settings.googleKey || DEFAULT_GOOGLE_KEY;
    const applied = await this.world.applyWorld(mode, { ionToken, googleKey });
    if (this.settings.quality) this.world.setQuality(this.settings.quality);
    if (this.settings.time != null) this.world.setTimeOfDay(this.settings.time);
    this.world.resetGroundSample(this.lastSpawn?.airborne ? null : this.fieldElev);
    return applied;
  }

  setTimeOfDay(h) { this.world.setTimeOfDay(h); }
  setQuality(q) { this.world.setQuality(q); }
  setVolume(v) { this.audio.setVolume(v); }
  setSensitivity(v) { this.input.sensitivity = v; }
  setInvertY(b) { this.input.invertY = b; }
  cycleCamera() { this.cam.cycle(); }

  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    const b = document.getElementById('btnPause');
    if (b) b.textContent = p ? '▶ Resume' : '⏸ Pause';
  }
  togglePause() {
    this.setPaused(!this.paused);
    this._toast(this.paused ? '⏸ Paused' : '▶ Flying');
  }

  // The menu doubles as a pause menu: opening it (Esc / ☰) freezes the sim,
  // closing it resumes — but only if the menu is what paused it, so a deliberate
  // pause (Pause button) or a crash freeze isn't accidentally resumed.
  _syncMenuPause(menuOpen) {
    if (menuOpen) {
      if (!this.paused) { this._menuPaused = true; this.setPaused(true); this._toast('⏸ Paused'); }
    } else if (this._menuPaused) {
      this._menuPaused = false; this.setPaused(false);
    }
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
