// Menu system, settings panel, airport/aircraft pickers, search, help overlay.
import { AIRPORTS, AIRCRAFT, KEY_HELP, saveSettings } from './config.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(app, settings) {
    this.app = app;
    this.s = settings;
    this._buildAirports();
    this._buildAircraft();
    this._buildKeyHelp();
    this._bind();
    this._applySettingsToControls();
    setInterval(() => this._pollPad(), 800);
  }

  // ---- build dynamic lists ----
  _buildAirports() {
    const host = $('airportList');
    host.innerHTML = '';
    for (const ap of AIRPORTS) {
      const b = document.createElement('button');
      b.className = 'airport' + (ap.airborne ? ' scenic' : '');
      b.innerHTML = `<span class="ic">${ap.airborne ? '✦' : '✈'}</span>
        <span class="nm">${ap.name}</span><span class="id">${ap.id}</span>`;
      b.onclick = () => { this.app.spawnAirport(ap); this.closeMenu(); };
      host.appendChild(b);
    }
  }

  _buildAircraft() {
    const host = $('aircraftList');
    host.innerHTML = '';
    for (const id in AIRCRAFT) {
      const ac = AIRCRAFT[id];
      const b = document.createElement('button');
      b.className = 'aircraft-card';
      b.dataset.id = id;
      b.innerHTML = `<div class="ac-name">${ac.name}</div><div class="ac-blurb">${ac.blurb}</div>`;
      b.onclick = () => {
        this.app.setAircraft(id);
        host.querySelectorAll('.aircraft-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
      };
      host.appendChild(b);
    }
    this.highlightAircraft(this.s.aircraft || 'pa28');
  }

  highlightAircraft(id) {
    $('aircraftList').querySelectorAll('.aircraft-card')
      .forEach(c => c.classList.toggle('active', c.dataset.id === id));
  }

  _buildKeyHelp() {
    const fill = (host) => {
      host.innerHTML = '';
      for (const [k, d] of KEY_HELP) {
        const row = document.createElement('div');
        row.className = 'key-row';
        row.innerHTML = `<kbd>${k}</kbd><span>${d}</span>`;
        host.appendChild(row);
      }
    };
    fill($('keyHelp'));
    fill($('helpGrid'));
  }

  // ---- event wiring ----
  _bind() {
    $('btnMenu').onclick = () => this.toggleMenu();
    $('menuClose').onclick = () => this.closeMenu();
    $('btnHelp').onclick = () => this.toggleHelp();
    $('helpClose').onclick = () => this.closeHelp();
    $('btnPanel').onclick = () => this.app.togglePanel();
    $('btnCam').onclick = () => this.app.cycleCamera();

    // tabs
    document.querySelectorAll('.mt').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.mt').forEach(x => x.classList.toggle('active', x === t));
        document.querySelectorAll('.menu-body .tab').forEach(sec =>
          sec.classList.toggle('active', sec.dataset.tab === t.dataset.tab));
      };
    });

    // fly tab
    $('btnPause').onclick = () => { this.app.togglePause(); };
    $('btnReset').onclick = () => { this.app.resetPosition(); this.closeMenu(); };
    $('searchBtn').onclick = () => this._search();
    $('searchBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._search(); });

    // world tab
    $('timeSlider').oninput = (e) => {
      const h = parseFloat(e.target.value);
      this.app.setTimeOfDay(h);
      $('timeLabel').textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')} (sun position)`;
      this.s.time = h; saveSettings(this.s);
    };
    this._seg('qualitySeg', 'q', (q) => { this.app.setQuality(q); this.s.quality = q; saveSettings(this.s); });
    this._seg('worldSeg', 'w', (w) => { this.s.worldMode = w; saveSettings(this.s); });
    $('btnApplyWorld').onclick = () => this._applyWorld();

    // controls tab
    $('invertY').onchange = (e) => { this.app.setInvertY(e.target.checked); this.s.invertY = e.target.checked; saveSettings(this.s); };
    $('sensSlider').oninput = (e) => { const v = parseFloat(e.target.value); this.app.setSensitivity(v); this.s.sensitivity = v; saveSettings(this.s); };
  }

  _seg(id, attr, cb) {
    const host = $(id);
    host.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        host.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        cb(b.dataset[attr]);
      };
    });
  }

  async _applyWorld() {
    const ionToken = $('ionToken').value.trim();
    const googleKey = $('googleKey').value.trim();
    const mode = this.s.worldMode || 'satellite';
    this.s.ionToken = ionToken; this.s.googleKey = googleKey; saveSettings(this.s);
    $('worldStatus').textContent = 'Loading world…';
    try {
      const applied = await this.app.applyWorld(mode, { ionToken, googleKey });
      const msg = {
        google: '✅ Google photorealistic 3D tiles active.',
        ion: '✅ Cesium ion terrain + 3D buildings active.',
        satellite: '✅ Free satellite imagery + terrain active.',
      };
      $('worldStatus').textContent = (applied !== mode)
        ? `⚠ Couldn't load "${mode}" (check the key) — fell back to ${applied}.`
        : msg[applied];
    } catch (e) {
      $('worldStatus').textContent = '⚠ ' + (e?.message || 'World failed to load.');
    }
  }

  async _search() {
    const q = $('searchBox').value.trim();
    if (!q) return;
    // direct "lat lon"
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { this.app.gotoLocation(parseFloat(m[1]), parseFloat(m[2])); this.closeMenu(); return; }
    $('searchBox').disabled = true;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (j[0]) { this.app.gotoLocation(parseFloat(j[0].lat), parseFloat(j[0].lon)); this.closeMenu(); }
      else $('searchBox').placeholder = 'Not found — try again';
    } catch { $('searchBox').placeholder = 'Search failed (offline?)'; }
    $('searchBox').disabled = false;
  }

  _pollPad() {
    const ok = this.app.input?.padConnected();
    $('padStatus').textContent = ok
      ? '🎮 Gamepad connected — left stick flies, triggers = throttle, A=gear, X/B=flaps, Y=camera.'
      : 'No gamepad detected. Plug one in and press a button.';
  }

  _applySettingsToControls() {
    const s = this.s;
    if (s.time != null) { $('timeSlider').value = s.time; $('timeLabel').textContent = `${String(Math.floor(s.time)).padStart(2, '0')}:00 (sun position)`; }
    if (s.quality) this._segSelect('qualitySeg', 'q', s.quality);
    this._segSelect('worldSeg', 'w', s.worldMode || 'satellite');
    if (s.ionToken) $('ionToken').value = s.ionToken;
    if (s.googleKey) $('googleKey').value = s.googleKey;
    if (s.invertY) $('invertY').checked = true;
    if (s.sensitivity) $('sensSlider').value = s.sensitivity;
  }

  _segSelect(id, attr, val) {
    $(id).querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset[attr] === val));
  }

  // ---- open/close ----
  toggleMenu() { $('menu').classList.toggle('hidden'); }
  closeMenu() { $('menu').classList.add('hidden'); }
  openMenu() { $('menu').classList.remove('hidden'); }
  toggleHelp() { $('help').classList.toggle('hidden'); }
  closeHelp() { $('help').classList.add('hidden'); }

  revealHud() {
    $('hud').classList.remove('hidden');
    $('toolbar').classList.remove('hidden');
  }
}
