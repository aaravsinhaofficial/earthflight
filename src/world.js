// Cesium world: viewer, imagery, terrain, photorealistic tiles, lighting, ground sampling.
import * as Cesium from 'cesium';

const ESRI_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_TERRAIN = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';

const QUALITY = {
  low:  { sse: 4,   tilesSse: 24, res: 0.85 },
  med:  { sse: 2,   tilesSse: 16, res: 1.0  },
  high: { sse: 1.5, tilesSse: 8,  res: 1.0  },
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

    // Resilience: a single undecodable imagery tile or a transient GPU hiccup
    // normally HALTS Cesium's render loop. Instead, shed load and resume.
    this._renderErrors = 0;
    scene.renderError.addEventListener((_scene, err) => {
      this._renderErrors++;
      console.warn('Cesium render error #' + this._renderErrors, err);
      if (this._renderErrors <= 25) {
        try {
          scene.highDynamicRange = false;
          if (this._renderErrors >= 2) this.setQuality('low'); // back off quality if it persists
        } catch { /* ignore */ }
        this.viewer.useDefaultRenderLoop = true; // resume rendering
      }
    });

    // We drive the camera ourselves; disable default mouse globe navigation.
    const c = scene.screenSpaceCameraController;
    c.enableInputs = false;

    this.googleTileset = null;
    this.osmBuildings = null;
    this._lastSample = 0;
    this._groundCache = 0;
    this.mode = 'satellite';
  }

  async init() {
    // Free, no-key default: ESRI satellite imagery + ESRI world terrain.
    await this.applyWorld('satellite', {});
    this.setQuality('med');
    this.setTimeOfDay(14);
  }

  setQuality(q) {
    const p = QUALITY[q] || QUALITY.med;
    this.viewer.scene.globe.maximumScreenSpaceError = p.sse;
    this.viewer.resolutionScale = p.res;
    if (this.googleTileset) this.googleTileset.maximumScreenSpaceError = p.tilesSse;
    if (this.osmBuildings) this.osmBuildings.maximumScreenSpaceError = p.tilesSse;
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
      if (mode === 'google' && googleKey) {
        // Full Google-Earth photorealistic 3D tiles. The tileset is the world,
        // so we keep a lightweight imagery globe underneath only for ground
        // sampling far from loaded tiles.
        Cesium.GoogleMaps.defaultApiKey = googleKey;
        this.googleTileset = await Cesium.createGooglePhotorealistic3DTileset({ key: googleKey });
        scene.primitives.add(this.googleTileset);
        scene.globe.show = false;
        await this._addEsriImagery();        // harmless; hidden globe
        scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        this.mode = 'google';
      } else if (mode === 'ion' && ionToken) {
        Cesium.Ion.defaultAccessToken = ionToken;
        scene.terrainProvider = await Cesium.createWorldTerrainAsync({ requestVertexNormals: true });
        // imagery: Bing aerial via ion world imagery
        try {
          const layer = Cesium.ImageryLayer.fromWorldImagery({});
          v.imageryLayers.add(layer);
        } catch { await this._addEsriImagery(); }
        try {
          this.osmBuildings = await Cesium.createOsmBuildingsAsync();
          scene.primitives.add(this.osmBuildings);
        } catch (e) { console.warn('OSM buildings failed', e); }
        this.mode = 'ion';
      } else {
        // free default
        await this._addEsriImagery();
        try {
          scene.terrainProvider = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(ESRI_TERRAIN);
        } catch (e) {
          console.warn('ESRI terrain failed, using flat ellipsoid', e);
          scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        }
        this.mode = 'satellite';
      }
    } catch (e) {
      console.error('applyWorld failed, falling back to satellite', e);
      v.imageryLayers.removeAll();
      await this._addEsriImagery();
      scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      scene.globe.show = true;
      this.mode = 'satellite';
      this._lastError = e?.message || String(e);
    }

    if (this._quality) this.setQuality(Object.keys(QUALITY).find(k => QUALITY[k] === this._quality) || 'med');
    return this.mode;
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

  // Best-effort ground/terrain height (m) under a lon/lat in DEGREES.
  // Throttled internally; samples 3D tiles when present, else terrain tiles.
  sampleGround(lonDeg, latDeg, fallback) {
    const now = performance.now();
    const carto = Cesium.Cartographic.fromDegrees(lonDeg, latDeg);
    if (now - this._lastSample > 90) {
      this._lastSample = now;
      let h;
      const scene = this.viewer.scene;
      if (this.googleTileset && scene.sampleHeightSupported) {
        try { h = scene.sampleHeight(carto, [], 2); } catch { /* ignore */ }
      }
      if (h === undefined || h === null) {
        h = this.viewer.scene.globe.getHeight(carto);
      }
      if (h !== undefined && h !== null && isFinite(h)) {
        // smooth to avoid jitter as tiles stream in
        this._groundCache = this._groundCache ? this._groundCache * 0.4 + h * 0.6 : h;
        this._hasSample = true;
      }
    }
    if (this._hasSample) return this._groundCache;
    return fallback ?? 0;
  }

  resetGroundSample(elev) {
    this._groundCache = elev || 0;
    this._hasSample = elev !== undefined && elev !== null;
    this._lastSample = 0;
  }

  get scene() { return this.viewer.scene; }
  get camera() { return this.viewer.camera; }
}
