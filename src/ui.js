// Menu system, settings panel, airport/aircraft pickers, search, help overlay.
import { AIRPORTS, AIRCRAFT, ROUTES, KEY_HELP, saveSettings } from './config.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(app, settings) {
    this.app = app;
    this.s = settings;
    this._buildRoutes();
    this._buildAirports();
    this._buildAircraft();
    this._buildKeyHelp();
    this._bind();
    this._applySettingsToControls();
    setInterval(() => this._pollPad(), 800);
  }

  // ---- build dynamic lists ----
  _buildRoutes() {
    const host = document.getElementById('routeList');
    if (!host) return;
    host.innerHTML = '';
    for (const r of ROUTES) {
      const b = document.createElement('button');
      b.className = 'route';
      b.innerHTML = `<span class="ic">🧭</span><span class="nm">${r.name}</span><span class="note">${r.note}</span>`;
      b.onclick = () => { this.app.setRoute(r); this.closeMenu(); };
      host.appendChild(b);
    }
  }

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
    $('volSlider').oninput = (e) => {
      const v = parseInt(e.target.value);
      this.app.setVolume(v / 100);
      $('volLabel').textContent = v === 0 ? 'Muted' : `Engine, wind & warnings — ${v}%`;
      this.s.volume = v / 100; saveSettings(this.s);
    };
    this._seg('qualitySeg', 'q', (q) => { this.app.setQuality(q); this.s.quality = q; saveSettings(this.s); });
    this._seg('worldSeg', 'w', (w) => { this.s.worldMode = w; saveSettings(this.s); });
    $('btnApplyWorld').onclick = () => this._applyWorld();

    // weather toggle
    $('realWeather').onchange = (e) => {
      this.s.realWeather = e.target.checked; saveSettings(this.s);
      const c = this.app.fm.cartographicDeg; this.app.fetchWeather(c.lat, c.lon);
      if (!e.target.checked) document.getElementById('hudWx')?.classList.add('hidden');
    };

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
        google: '✅ Photorealistic 3D — real textured Google-Earth buildings.',
        ion: '✅ Cesium ion terrain + OSM 3D building shapes.',
        satellite: '✅ Free satellite imagery + terrain (no 3D buildings).',
      };
      if (applied !== mode) this.syncWorldMode(applied);   // persist + reflect the fallback
      $('worldStatus').textContent = (applied !== mode)
        ? `⚠ Couldn't load "${mode}" — fell back to ${applied}. (ion token may be over quota.)`
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
    if (s.volume != null) {
      const v = Math.round(s.volume * 100);
      $('volSlider').value = v;
      $('volLabel').textContent = v === 0 ? 'Muted' : `Engine, wind & warnings — ${v}%`;
    }
    if (s.realWeather === false) $('realWeather').checked = false;
    if (s.sensitivity) $('sensSlider').value = s.sensitivity;
  }

  _segSelect(id, attr, val) {
    $(id).querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset[attr] === val));
  }

  // Reflect a world-mode change that didn't originate from the segment buttons
  // (e.g. an automatic photoreal→fallback) in both the saved settings and the UI.
  syncWorldMode(mode) {
    this.s.worldMode = mode; saveSettings(this.s);
    this._segSelect('worldSeg', 'w', mode);
  }

  syncTime(sliderVal, localHour) {
    const sl = document.getElementById('timeSlider'); if (sl) sl.value = sliderVal;
    const lbl = document.getElementById('timeLabel');
    if (lbl) lbl.textContent = `${String(Math.floor(localHour)).padStart(2, '0')}:${String(Math.floor((localHour % 1) * 60)).padStart(2, '0')} — real local time`;
    this.s.time = sliderVal; saveSettings(this.s);
  }

  showWeather(w) {
    const el = document.getElementById('hudWx');
    if (!el || !w) return;
    const ktw = Math.round((w.windSpeed || 0) * 1.94384);
    el.classList.remove('hidden');
    el.innerHTML = `${this._wxIcon(w.code)} ${Math.round(w.temp)}°C &nbsp; 🌬 ${String(Math.round(w.windDir)).padStart(3, '0')}°/${ktw}kt`;
    const s = document.getElementById('wxStatus');
    if (s) s.textContent = `Now: ${this._wxText(w.code)}, ${Math.round(w.cloud)}% cloud, wind ${ktw} kt from ${Math.round(w.windDir)}°.`;
  }
  _wxIcon(c) {
    if ([45, 48].includes(c)) return '🌫'; if (c >= 95) return '⛈'; if (c >= 80) return '🌦';
    if (c >= 71 && c <= 77) return '❄️'; if (c >= 51 && c <= 67) return '🌧'; if (c >= 1 && c <= 3) return '⛅'; return '☀️';
  }
  _wxText(c) {
    if ([45, 48].includes(c)) return 'fog'; if (c >= 95) return 'thunderstorm'; if (c >= 80) return 'showers';
    if (c >= 71 && c <= 77) return 'snow'; if (c >= 51 && c <= 67) return 'rain'; if (c >= 1 && c <= 3) return 'partly cloudy'; return 'clear';
  }

  // ---- open/close ---- (the menu is also the pause menu: see App._syncMenuPause)
  toggleMenu() { $('menu').classList.toggle('hidden'); this.app._syncMenuPause(!$('menu').classList.contains('hidden')); }
  closeMenu() { $('menu').classList.add('hidden'); this.app._syncMenuPause(false); }
  openMenu() { $('menu').classList.remove('hidden'); this.app._syncMenuPause(true); }
  toggleHelp() { $('help').classList.toggle('hidden'); }
  closeHelp() { $('help').classList.add('hidden'); }

  revealHud() {
    $('hud').classList.remove('hidden');
    $('toolbar').classList.remove('hidden');
  }
}
