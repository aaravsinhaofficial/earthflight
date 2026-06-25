// Cesium world: viewer, imagery, terrain, photorealistic tiles, lighting, ground sampling.
import * as Cesium from 'cesium';

const ESRI_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_TERRAIN = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';

const MB = 1024 * 1024;
const QUALITY = {
  // sse=globe SSE (satellite/ion) · tilesSse=Google P3DT SSE · res=resolutionScale ·
  // msaa samples · cacheBytes/overflow=tile memory governors (overflow is the crash guard)
  // tilesSse = cruise SSE (coarsest) · groundSse = sharpest SSE on short final
  low:  { sse: 4,   tilesSse: 20, groundSse: 14, res: 0.8, msaa: 1, envMap: false, ao: false,
          cacheBytes: 256 * MB, overflow: 96 * MB, dsseDensity: 0.0004, foveatedCone: 0.2, foveatedDelay: 0.5, cullMult: 120 },
  med:  { sse: 2,   tilesSse: 16, groundSse: 8,  res: 0.9, msaa: 2, envMap: true,  ao: false,
          cacheBytes: 384 * MB, overflow: 128 * MB, dsseDensity: 0.0003, foveatedCone: 0.3, foveatedDelay: 0.3, cullMult: 60 },
  high: { sse: 1.5, tilesSse: 10, groundSse: 6,  res: 1.0, msaa: 4, envMap: true,  ao: true,
          cacheBytes: 512 * MB, overflow: 192 * MB, dsseDensity: 0.0002, foveatedCone: 0.35, foveatedDelay: 0.2, cullMult: 60 },
};

export class World {
  constructor(containerId) {
    this.viewer = new Cesium.Viewer(containerId, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
      showRenderLoopErrors: false, // we handle render errors ourselves (see below)
      contextOptions: { webgl: { powerPreference: 'high-performance' } },
    });

    const v = this.viewer;
    v.cesiumWidget.creditContainer.style.display = 'none'; // we render credits ourselves in UI

    const scene = v.scene;
    scene.globe.enableLighting = true;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.showGroundAtmosphere = true;
    scene.skyAtmosphere.show = true;
    scene.fog.enabled = true;
    scene.fog.density = 0.0001;
    scene.highDynamicRange = false; // HDR doubles framebuffer memory — skip it for stability
    scene.postProcessStages.fxaa.enabled = true;
    scene.screenSpaceCameraController.enableCollisionDetection = true;
    scene.verticalExaggeration = 1.0; // photoreal tiles are true-scale — never distort them

    // Light the Google photoreal tiles with the REAL sun direction (matched to the
    // time of day) instead of their flat baked lighting — the single biggest "flat
    // satellite paste → lit 3D world" win, and it costs ~no GPU memory. A touch of
    // photographic grade (a hair more saturation, slightly darker) makes it pop.
    try {
      scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.SUNLIGHT;
      scene.atmosphere.saturationShift = 0.05;
      scene.atmosphere.brightnessShift = -0.02;
    } catch { /* older Cesium — skip */ }

    // Resilience: a single undecodable imagery tile or a transient GPU hiccup
    // normally HALTS Cesium's render loop. Instead, shed load and resume.
    // The counter tracks CONSECUTIVE errors (it decays on healthy frames, see
    // onFrame), so unrelated blips spread across a long flight never accumulate
    // into a permanent freeze. A temporary quality downgrade is held separately
    // from the user's saved preference and restored once things settle.
    this._renderErrors = 0;
    this._lastRenderError = 0;
    this._tempLow = false;
    this._savedQuality = 'med';
    scene.renderError.addEventListener((_scene, err) => {
      this._renderErrors++;
      this._lastRenderError = performance.now();
      console.warn('Cesium render error #' + this._renderErrors, err);
      if (this._renderErrors <= 25 && !this._contextLost) {
        try {
          scene.highDynamicRange = false;
          scene.msaaSamples = 1;                         // shed framebuffer memory
          if (this.googleTileset) {                      // shed near-ground tile floods
            this.googleTileset.maximumScreenSpaceError += 4;
            this.googleTileset.maximumCacheOverflowBytes = 64 * 1024 * 1024;
            if (this.googleTileset.environmentMapManager) this.googleTileset.environmentMapManager.enabled = false;
          }
          if (this._renderErrors >= 2 && !this._tempLow) { this._tempLow = true; this._applyQuality('low'); }
        } catch { /* ignore */ }
        this.viewer.useDefaultRenderLoop = true; // resume rendering
      }
    });

    // WebGL context loss (driver reclaims the GPU under memory pressure — the
    // user's documented 50-tab/18GB failure mode) is a DIFFERENT beast from a
    // per-tile render error: every gl call throws until the context is restored,
    // which would otherwise burn the 25-strike counter in milliseconds. Pause the
    // loop and wait for restore instead of fighting it.
    const canvas = scene.canvas;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
      this.viewer.useDefaultRenderLoop = false;
      console.warn('WebGL context lost — pausing render loop until restored');
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      this._contextLost = false;
      this._renderErrors = 0;
      this._tempLow = true; this._applyQuality('low'); // come back gently
      this.viewer.useDefaultRenderLoop = true;
      console.warn('WebGL context restored — resuming');
    }, false);

    // We drive the camera ourselves; disable default mouse globe navigation.
    const c = scene.screenSpaceCameraController;
    c.enableInputs = false;

    this.googleTileset = null;
    this.osmBuildings = null;
    this._worldTerrain = null;   // standalone terrain provider for async ground sampling
    this._sampling = false;
    this._lastSample = 0;
    this._groundCache = 0;
    this._hasSample = false;
    this.mode = 'satellite';

    // Dynamic "sharpen the photoreal tiles when you're near the ground" — the lever
    // that makes airports crisp on approach without flooding the cache at cruise.
    // Sharper (lower SSE) bands kick in as AGL drops; hysteresis + slew + debounce
    // keep tile churn (and the render-loop crashes it causes) under control.
    // AGL thresholds for band 0 (short final) … band 3 (cruise); the band index
    // interpolates the tile SSE between the tier's groundSse (sharp) and tilesSse.
    this._sseBandAgl = [150, 600, 2000, Infinity];
    this._bandIdx = this._sseBandAgl.length - 1;
    this._dispSSE = 16;
    this._lastBandChange = 0;
    this._lastAgl = 1e9;
  }

  // Called each frame with the aircraft's AGL (m). Drives the Google tileset's SSE
  // from altitude so the ground sharpens on descent and relaxes on climb.
  updateGroundSharpness(agl, dt, now) {
    const t = this.googleTileset;
    if (this.mode !== 'google' || !t || this._tempLow) return; // don't fight the error backoff
    const HYST = 120, SLEW = 4, DEBOUNCE = 800, N = this._sseBandAgl.length;
    const goingDown = agl < this._lastAgl; this._lastAgl = agl;
    let want = N - 1;
    for (let i = 0; i < N; i++) {
      if (agl < this._sseBandAgl[i] + (goingDown ? -HYST : HYST)) { want = i; break; }
    }
    if (want !== this._bandIdx && now - this._lastBandChange > DEBOUNCE) {
      this._bandIdx = want; this._lastBandChange = now;
    }
    // interpolate SSE between the tier's sharp (ground) and coarse (cruise) values,
    // by band index — so 'med' goes 16 (cruise) → 8 (short final), within the tier.
    const cruise = this._quality?.tilesSse ?? 16, ground = this._quality?.groundSse ?? cruise;
    const target = ground + (this._bandIdx / (N - 1)) * (cruise - ground);
    const d = target - this._dispSSE;
    this._dispSSE += Math.sign(d) * Math.min(SLEW * dt, Math.abs(d)); // slew, don't jump
    t.maximumScreenSpaceError = this._dispSSE;
    const onApproach = this._bandIdx <= 1;
    try { t.dynamicScreenSpaceErrorHeightFalloff = onApproach ? 0.4 : 0.25; } catch { /* ignore */ }
  }

  // Called once per frame from main. Decays the render-error counter when the
  // scene has been healthy, and restores the user's quality after a temporary
  // backoff so a momentary hiccup doesn't pin 'low' for the rest of the session.
  onFrame() {
    if (this._renderErrors > 0 && performance.now() - this._lastRenderError > 8000) {
      this._renderErrors = 0;
      if (this._tempLow) { this._tempLow = false; this._applyQuality(this._savedQuality); }
    }
  }

  async init() {
    // Free, no-key default: ESRI satellite imagery + ESRI world terrain.
    await this.applyWorld('satellite', {});
    this.setQuality('med');
    this.setTimeOfDay(14);
  }

  // The user's chosen quality. Remembered so a temporary render-error backoff to
  // 'low' can be undone later without clobbering the preference.
  setQuality(q) {
    if (QUALITY[q]) this._savedQuality = q;
    if (this._tempLow) return;          // a backoff is active — don't override it
    this._applyQuality(q);
  }

  _applyQuality(q) {
    const p = QUALITY[q] || QUALITY.med;
    const scene = this.viewer.scene;
    scene.globe.maximumScreenSpaceError = p.sse;
    this.viewer.resolutionScale = p.res;
    scene.msaaSamples = p.msaa;              // anti-aliasing (4 is too costly on a fragile GPU; med→2)
    if (this.osmBuildings) this.osmBuildings.maximumScreenSpaceError = p.tilesSse;
    const t = this.googleTileset;
    if (t) {
      t.maximumScreenSpaceError = p.tilesSse;
      // Memory governors — sharpness comes from SSE+cache, NOT from these aggressive
      // flags which spike peak memory / cause popping on a fragile GPU.
      t.cacheBytes = p.cacheBytes;
      t.maximumCacheOverflowBytes = p.overflow;   // ← crash guard (Cesium default 512MB is dangerous)
      t.dynamicScreenSpaceError = true;            // relax far/horizon tiles → budget for near ground
      t.dynamicScreenSpaceErrorDensity = p.dsseDensity;
      t.foveatedScreenSpaceError = true;           // load center-screen (the runway) first
      t.foveatedConeSize = p.foveatedCone;
      t.foveatedTimeDelay = p.foveatedDelay;
      t.cullRequestsWhileMoving = true;
      t.cullRequestsWhileMovingMultiplier = p.cullMult;
      t.skipLevelOfDetail = false;                 // OFF → clean ground, no blur→sharp popping
      t.preferLeaves = false;                      // OFF → lower peak memory
      t.loadSiblings = false;                      // OFF → fewer resident tiles
      t.preloadFlightDestinations = false;         // OFF → no prefetch memory spikes
      if (t.environmentMapManager) t.environmentMapManager.enabled = p.envMap; // sky-ambient (med/high)
    }
    // ambient occlusion: cheap-ish contact shadows that make flat photogrammetry read
    // as 3D — but it's a multi-pass VRAM cost, so high tier only.
    try {
      const ao = scene.postProcessStages.ambientOcclusion;
      ao.enabled = !!p.ao;
      if (p.ao) { ao.uniforms.intensity = 2.0; ao.uniforms.directionCount = 4; ao.uniforms.stepCount = 16; }
    } catch { /* ignore */ }
    this._quality = p;
  }

  // mode: 'satellite' | 'ion' | 'google'
  async applyWorld(mode, { ionToken, googleKey }) {
    const v = this.viewer;
    const scene = v.scene;

    // tear down any photoreal / building tilesets
    if (this.googleTileset) { scene.primitives.remove(this.googleTileset); this.googleTileset = null; }
    if (this.osmBuildings) { scene.primitives.remove(this.osmBuildings); this.osmBuildings = null; }
    v.imageryLayers.removeAll();
    scene.globe.show = true;

    try {
      if (mode === 'google' && (googleKey || ionToken)) {
        // Full Google-Earth PHOTOREALISTIC 3D tiles — real, textured buildings
        // (not the plain OSM blocks). Two ways in, in priority order:
        //   • a Google Maps "Map Tiles API" key (direct), or
        //   • NO key → Cesium routes it through your ion token (ion curated asset
        //     2275207), so the token you already have gives real buildings.
        // The tileset IS the world, so the imagery globe underneath is only kept
        // for ground sampling far from loaded tiles.
        if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;
        const apiOpts = { onlyUsingWithGoogleGeocoder: true };
        if (googleKey) { Cesium.GoogleMaps.defaultApiKey = googleKey; apiOpts.key = googleKey; }
        // Memory-bounded: the default 1.5 GB tile cache is too much for a busy
        // machine and triggers the render-loop crashes we guard against. Cap it.
        this.googleTileset = await Cesium.createGooglePhotorealistic3DTileset(apiOpts, {
          maximumScreenSpaceError: this._quality?.tilesSse || 16,
          cacheBytes: 384 * 1024 * 1024,
          maximumCacheOverflowBytes: 128 * 1024 * 1024,  // tightened crash guard (see _applyQuality)
        });
        // Photoreal tiles are already-lit photos — full specular IBL makes them look
        // plasticky. Keep diffuse ambient, cut specular so the ground reads natural.
        try { this.googleTileset.imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(1.0, 0.3); } catch { /* ignore */ }
        scene.primitives.add(this.googleTileset);
        scene.globe.show = false;
        // The photoreal mesh is buildings+ground fused together, so it can't be a
        // ground reference for the flight model (it'd read rooftops). Keep a real
        // TERRAIN provider on the side for async elevation sampling (see sampleGround),
        // and leave the hidden globe flat/cheap.
        if (!this._worldTerrain) {
          try { this._worldTerrain = await Cesium.createWorldTerrainAsync(); }
          catch (e) { console.warn('ground-sampling terrain failed', e); this._worldTerrain = null; }
        }
        await this._addEsriImagery();        // harmless; hidden globe
        scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        this.mode = 'google';
        // The root metadata can resolve even when the (shared) ion token is over
        // its Google-tiles quota or unauthorized for the asset — then every TILE
        // 401/403/429s and you'd stare at an empty void with a false "success".
        // Watch for a burst of early tile failures and gracefully fall back.
        this._fallbackKeys = { ionToken, googleKey };
        this._googleFails = 0;
        const createdAt = performance.now();
        this.googleTileset.tileFailed.addEventListener(() => {
          this._googleFails++;
          if (this._googleFails >= 8 && performance.now() - createdAt < 15000) this._degradeFromGoogle('tile errors (quota/auth?)');
        });
      } else if (mode === 'ion' && ionToken) {
        Cesium.Ion.defaultAccessToken = ionToken;
        scene.terrainProvider = await Cesium.createWorldTerrainAsync({ requestVertexNormals: true });
        // imagery: Bing aerial via ion world imagery
        try {
          const layer = Cesium.ImageryLayer.fromWorldImagery({});
          v.imageryLayers.add(layer);
        } catch { await this._addEsriImagery(); }
        try {
          // Height-graded tint so the OSM extrusions read as a skyline instead of
          // a field of flat white blocks (this mode has no photo texture — for real
          // textured buildings use the photorealistic 'google' mode).
          this.osmBuildings = await Cesium.createOsmBuildingsAsync({
            style: new Cesium.Cesium3DTileStyle({
              color: "mix(color('#8b94a3'), color('#eef2f7'), min(${feature['cesium#estimatedHeight']} / 140.0, 1.0))",
            }),
          });
          scene.primitives.add(this.osmBuildings);
        } catch (e) { console.warn('OSM buildings failed', e); }
        this.mode = 'ion';
      } else {
        await this._applySatellite();        // free default
      }
    } catch (e) {
      console.error('applyWorld failed, falling back to satellite', e);
      // Make the fallback idempotent no matter how far the try got: rip out any
      // half-built tileset (else you double-render a tileset AND the globe), and
      // restore the SAME real-terrain satellite world the dedicated mode builds.
      if (this.googleTileset) { scene.primitives.remove(this.googleTileset); this.googleTileset = null; }
      if (this.osmBuildings) { scene.primitives.remove(this.osmBuildings); this.osmBuildings = null; }
      v.imageryLayers.removeAll();
      scene.globe.show = true;
      try { await this._applySatellite(); } catch { scene.terrainProvider = new Cesium.EllipsoidTerrainProvider(); }
      this.mode = 'satellite';
      this._lastError = e?.message || String(e);
    }

    // Re-apply the EFFECTIVE quality to the freshly-built tilesets — without
    // touching the saved preference (a temporary backoff must not become sticky).
    this._applyQuality(this._tempLow ? 'low' : (this._savedQuality || 'med'));
    return this.mode;
  }

  // Free, no-key world: ESRI satellite imagery + ESRI 3D terrain. Shared by the
  // 'satellite' mode and every failure fallback so they're identical (real terrain,
  // not a flat ellipsoid).
  async _applySatellite() {
    await this._addEsriImagery();
    try {
      this.viewer.scene.terrainProvider = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(ESRI_TERRAIN);
    } catch (e) {
      console.warn('ESRI terrain failed, using flat ellipsoid', e);
      this.viewer.scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
    this.mode = 'satellite';
  }

  // Photoreal tiles are failing (token quota / unauthorized) — bail out to a
  // working world (OSM buildings if we have an ion token, else flat satellite) and
  // tell the app so it can update the menu + persist, instead of a black void.
  async _degradeFromGoogle(reason) {
    if (this._degrading || this.mode !== 'google') return;
    this._degrading = true;
    console.warn('Photoreal 3D tiles failing — falling back:', reason);
    const keys = this._fallbackKeys || {};
    const target = keys.ionToken ? 'ion' : 'satellite';
    const applied = await this.applyWorld(target, keys);
    this._degrading = false;
    this.onModeFallback?.(applied, reason);
  }

  async _addEsriImagery() {
    // Use a direct tile-URL template (no `?f=json` metadata fetch). The metadata
    // request gets rate-limited and returns HTML, which used to leave the globe
    // textureless. Direct tiles just work.
    try {
      this.viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: ESRI_IMAGERY + '/tile/{z}/{y}/{x}',
          maximumLevel: 19,
          credit: 'Esri, Maxar, Earthstar Geographics, and the GIS community',
        })
      );
    } catch (e) {
      console.warn('ESRI imagery failed, using OSM', e);
      this.viewer.imageryLayers.addImageryProvider(
        new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
      );
    }
  }

  // Draw a runway (asphalt + centerline + edge stripes) draped on the ground at a
  // grounded spawn so you clearly start lined up for takeoff. Call hideRunway()
  // for airborne starts.
  showRunway(lonDeg, latDeg, headingDeg, length = 3800, width = 60) {
    this.hideRunway();
    const hdg = headingDeg * Math.PI / 180;
    const cosL = Math.cos(latDeg * Math.PI / 180);
    const along = [Math.cos(hdg), Math.sin(hdg)];   // [north, east] components
    const across = [-Math.sin(hdg), Math.cos(hdg)];
    const off = (dN, dE) => [lonDeg + dE / (111320 * cosL), latDeg + dN / 111320];
    const pt = (s, t) => off(
      s * length / 2 * along[0] + t * width / 2 * across[0],
      s * length / 2 * along[1] + t * width / 2 * across[1]
    );
    const c1 = pt(1, 1), c2 = pt(1, -1), c3 = pt(-1, -1), c4 = pt(-1, 1);
    const ents = this.viewer.entities;
    const both = Cesium.ClassificationType.BOTH;

    this._runway = [];
    this._runway.push(ents.add({
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray([...c1, ...c2, ...c3, ...c4]),
        material: Cesium.Color.fromCssColorString('#26262b'),
        classificationType: both,
      },
    }));
    // dashed centerline
    const e1 = off(length / 2 * along[0], length / 2 * along[1]);
    const e2 = off(-length / 2 * along[0], -length / 2 * along[1]);
    this._runway.push(ents.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([...e1, ...e2]),
        width: 3, clampToGround: true,
        material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE, dashLength: 24 }),
      },
    }));
    // solid edge stripes
    for (const t of [1, -1]) {
      const a = pt(1, t), b = pt(-1, t);
      this._runway.push(ents.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([...a, ...b]),
          width: 2, clampToGround: true,
          material: Cesium.Color.WHITE.withAlpha(0.85),
        },
      }));
    }
  }

  hideRunway() {
    if (this._runway) { this._runway.forEach((e) => this.viewer.entities.remove(e)); this._runway = null; }
  }

  // Draw a route line from origin to destination + a tall destination beacon.
  showRoute(fromLat, fromLon, toLat, toLon, toName) {
    this.hideRoute();
    const ents = this.viewer.entities;
    const glow = (c, p) => new Cesium.PolylineGlowMaterialProperty({ color: c, glowPower: p });
    this._route = [];
    this._route.push(ents.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([fromLon, fromLat, toLon, toLat]),
        width: 3, clampToGround: true, material: glow(Cesium.Color.CYAN, 0.25),
      },
    }));
    this._route.push(ents.add({
      position: Cesium.Cartesian3.fromDegrees(toLon, toLat, 1600),
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([toLon, toLat, 0, toLon, toLat, 3200]),
        width: 4, material: glow(Cesium.Color.CYAN.withAlpha(0.85), 0.35),
      },
      label: {
        text: '🎯 ' + toName, font: 'bold 14px -apple-system, sans-serif', fillColor: Cesium.Color.WHITE,
        showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(10,13,18,0.85)'),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));
  }

  hideRoute() {
    if (this._route) { this._route.forEach((e) => this.viewer.entities.remove(e)); this._route = null; }
  }

  // hour: 0..24 (UTC-ish). Drives sun position for day/night lighting.
  setTimeOfDay(hour) {
    const base = Cesium.JulianDate.fromIso8601('2025-06-21T00:00:00Z');
    const t = Cesium.JulianDate.addSeconds(base, hour * 3600, new Cesium.JulianDate());
    this.viewer.clock.currentTime = t;
    this.viewer.clock.shouldAnimate = false;
  }

  // 0 (full day) … 1 (full night) at the aircraft, from the real sun elevation.
  // Cached ~1 Hz (the sun barely moves). Also drives the world darkening.
  nightFactor(lonRad, latRad, now) {
    if (now - (this._nfAt || 0) < 1000 && this._nf != null) return this._nf;
    this._nfAt = now;
    const t = this.viewer.clock.currentTime;
    const sun = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t, this._sunTmp || (this._sunTmp = new Cesium.Cartesian3()));
    const icrf = Cesium.Transforms.computeIcrfToFixedMatrix(t, this._icrf || (this._icrf = new Cesium.Matrix3()));
    if (Cesium.defined(icrf)) Cesium.Matrix3.multiplyByVector(icrf, sun, sun); // ICRF → ECEF
    const pos = Cesium.Cartesian3.fromRadians(lonRad, latRad, 0, Cesium.Ellipsoid.WGS84, this._posTmp || (this._posTmp = new Cesium.Cartesian3()));
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, this._upTmp || (this._upTmp = new Cesium.Cartesian3()));
    Cesium.Cartesian3.normalize(sun, sun);
    const elevDeg = Cesium.Math.toDegrees(Math.asin(Cesium.Math.clamp(Cesium.Cartesian3.dot(sun, up), -1, 1)));
    this._nf = Cesium.Math.clamp(-elevDeg / 6, 0, 1);   // civil-twilight ramp: 0° day → -6° full night
    this.applyNight(this._nf);
    return this._nf;
  }

  // Darken the scene at night: dim the directional light, mute the atmosphere, and
  // a CSS multiply overlay (the part that actually sells night over baked-daylit tiles).
  applyNight(nf) {
    const scene = this.viewer.scene;
    // dim the sun light without REPLACING it (replacing would freeze the sun
    // direction so it'd stop tracking time-of-day). The big night effect is the
    // atmosphere mute + the CSS tint below — baked-daylit tiles ignore scene.light.
    try { if (scene.light) scene.light.intensity = Cesium.Math.lerp(2.0, 0.5, nf); } catch { /* ignore */ }
    const A = scene.atmosphere;
    if (A) {
      A.brightnessShift = Cesium.Math.lerp(-0.02, -0.7, nf);
      A.saturationShift = Cesium.Math.lerp(0.05, -0.3, nf);
      try { A.lightIntensity = Cesium.Math.lerp(10.0, 1.0, nf); } catch { /* ignore */ }
    }
    if (!this._nightDiv) {
      const d = document.createElement('div');
      d.id = 'nightTint';
      d.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;background:#0a1020;mix-blend-mode:multiply;opacity:0;transition:opacity .8s;';
      document.getElementById('cesiumContainer').appendChild(d);
      this._nightDiv = d;
    }
    this._nightDiv.style.opacity = (nf * 0.55).toFixed(3);
  }

  // Runway edge (warm white) + threshold (green) + far-end (red) lights — one static
  // PointPrimitiveCollection, built at a grounded spawn, culled past 25 km. Positioned
  // at the actual ground the aircraft rests on (see alignRunwayLights), so they sit ON
  // the runway in photoreal mode rather than floating at the config field elevation.
  buildRunwayLights(lonDeg, latDeg, headingDeg, elev, length = 3000, halfW = 22) {
    this.hideRunwayLights();
    this._rwyOrigin = { lonDeg, latDeg, headingDeg };
    this._rwyElev = elev || 0;
    const rwy = this.viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
    this._rwyLights = rwy;
    this._rwyPts = [];  // {pt, along, across} so we can reposition in place as ground converges
    const ddc = new Cesium.DistanceDisplayCondition(0, 25000);
    const edge = Cesium.Color.fromCssColorString('#FFF4E0'), grn = Cesium.Color.fromCssColorString('#00FF66'), red = Cesium.Color.fromCssColorString('#FF3030');
    const show = !!this._rwyVisible;
    const place = (along, across, color, size) => {
      const pt = rwy.add({ position: new Cesium.Cartesian3(), color, pixelSize: size, show,
        disableDepthTestDistance: 200, distanceDisplayCondition: ddc, scaleByDistance: new Cesium.NearFarScalar(500, 1.0, 15000, 0.3) });
      this._rwyPts.push({ pt, along, across });
    };
    for (let d = -length / 2; d <= length / 2; d += 60) { place(d, -halfW, edge, 6); place(d, halfW, edge, 6); }
    for (let a = -halfW; a <= halfW; a += 7) { place(-length / 2, a, grn, 8); place(length / 2, a, red, 8); }
    this._positionRunwayLights(this._rwyElev);
  }
  _positionRunwayLights(elev) {
    const o = this._rwyOrigin; if (!o || !this._rwyPts) return;
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(o.lonDeg, o.latDeg, elev));
    const hdg = Cesium.Math.toRadians(o.headingDeg);
    const fwd = new Cesium.Cartesian3(Math.sin(hdg), Math.cos(hdg), 0);
    const side = new Cesium.Cartesian3(Math.cos(hdg), -Math.sin(hdg), 0);
    for (const r of this._rwyPts) {
      const local = new Cesium.Cartesian3(fwd.x * r.along + side.x * r.across, fwd.y * r.along + side.y * r.across, 0.4);
      r.pt.position = Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
    }
  }
  // Keep the runway lights on the same ground plane the aircraft uses. The flat-zone
  // elevation converges from a terrain sample over the first second; reposition the
  // existing points (no rebuild) so they sit ON the runway, never floating above it.
  alignRunwayLights(elev) {
    if (!this._rwyLights || Math.abs(elev - this._rwyElev) < 0.3) return;
    this._rwyElev = elev;
    this._positionRunwayLights(elev);
  }
  hideRunwayLights() { if (this._rwyLights) { this.viewer.scene.primitives.remove(this._rwyLights); this._rwyLights = null; this._rwyPts = null; } }
  setRunwayLightsVisible(on) { this._rwyVisible = on; if (this._rwyLights) for (let i = 0; i < this._rwyLights.length; i++) this._rwyLights.get(i).show = on; }

  // Best-effort TERRAIN height (m) under a lon/lat in DEGREES — the ground the
  // flight model rests/lands on. Deliberately NOT the rendered surface: in
  // photoreal 'google' mode the tiles are buildings+ground fused into one mesh,
  // and the visible globe is off, so a depth pick would return rooftops (or the
  // aircraft's own model). Instead we sample a real terrain provider:
  //   • google mode → async sampleTerrainMostDetailed against a standalone world-
  //     terrain provider (decoupled from the hidden globe), cached between calls.
  //   • satellite/ion mode → the shown globe's getHeight (synchronous, real terrain).
  // Building tops are handled separately by sampleSceneHeight (collision only).
  sampleGround(lonDeg, latDeg, fallback) {
    const now = performance.now();
    const carto = Cesium.Cartographic.fromDegrees(lonDeg, latDeg);
    if (this.mode === 'google') {
      // async: kick off a most-detailed terrain query, update the cache when it lands
      if (now - this._lastSample > 220 && this._worldTerrain && !this._sampling) {
        this._lastSample = now;
        this._sampling = true;
        Cesium.sampleTerrainMostDetailed(this._worldTerrain, [Cesium.Cartographic.fromDegrees(lonDeg, latDeg)])
          .then(([s]) => {
            if (s && s.height != null && isFinite(s.height)) {
              this._groundCache = this._hasSample ? this._groundCache * 0.5 + s.height * 0.5 : s.height;
              this._hasSample = true;
            }
          })
          .catch(() => { /* ignore */ })
          .finally(() => { this._sampling = false; });
      }
    } else if (now - this._lastSample > 90) {
      this._lastSample = now;
      const h = this.viewer.scene.globe.getHeight(carto);
      if (h !== undefined && h !== null && isFinite(h)) {
        // smooth to avoid jitter as terrain tiles stream in (use the flag, not the
        // value, so a legitimate 0 m sea-level ground still smooths correctly)
        this._groundCache = this._hasSample ? this._groundCache * 0.4 + h * 0.6 : h;
        this._hasSample = true;
      }
    }
    if (this._hasSample) return this._groundCache;
    return fallback ?? 0;
  }

  // Height of the rendered scene (terrain + 3D buildings/tiles) under a lon/lat —
  // used to detect flying into a building. Throttled; needs depth-texture support.
  sampleSceneHeight(lonDeg, latDeg, exclude) {
    const now = performance.now();
    if (now - (this._lastScene || 0) < 130) return this._sceneH ?? null;
    this._lastScene = now;
    const scene = this.viewer.scene;
    if (!scene.sampleHeightSupported) { this._sceneH = null; return null; }
    let h = null;
    try { h = scene.sampleHeight(Cesium.Cartographic.fromDegrees(lonDeg, latDeg), exclude ? [exclude] : [], 1); }
    catch { h = null; }
    this._sceneH = (h !== undefined && h !== null && isFinite(h)) ? h : null;
    return this._sceneH;
  }

  // Visibility/haze from a weather report (Open-Meteo weather_code + cloud cover).
  applyWeather(w) {
    const scene = this.viewer.scene;
    const code = w.code || 0;
    let fog;
    if ([45, 48].includes(code)) fog = 0.0022;            // fog
    else if (code >= 51 && code <= 67) fog = 0.0008;      // drizzle / rain
    else if (code >= 71 && code <= 77) fog = 0.0012;      // snow
    else if (code >= 80) fog = 0.0013;                    // showers / thunderstorm
    else fog = 0.00012 + (w.cloud || 0) / 100 * 0.00028;  // haze grows with cloud cover
    scene.fog.enabled = true;
    scene.fog.density = fog;
  }

  resetGroundSample(elev) {
    this._groundCache = elev || 0;
    this._hasSample = elev !== undefined && elev !== null;
    this._lastSample = 0;
  }

  get scene() { return this.viewer.scene; }
  get camera() { return this.viewer.camera; }
}
