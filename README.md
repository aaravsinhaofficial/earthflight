# ✈ EarthFlight

A browser-based flight simulator that flies over the **real Earth** — real satellite
imagery, real terrain, and (optionally) full Google-Earth photorealistic 3D tiles.
Built entirely with [CesiumJS](https://cesium.com/platform/cesiumjs/) and vanilla
JavaScript. No game engine, no native install — it runs in any modern browser.

![stack](https://img.shields.io/badge/CesiumJS-1.142-blue) ![vite](https://img.shields.io/badge/Vite-5-purple)

## Features

- **Real-world globe** — worldwide satellite imagery + 3D terrain elevation, **free and no API key required**.
- **Six real aircraft** — Piper PA-28 Cherokee, Cessna Citation, Boeing 737-800 / 787-9 / 747-400, Airbus A320 (3D models from the Flightradar24 project), each with its own flight tuning.
- **Point-mass flight physics** — thrust, lift, drag, angle-of-attack, stalls, banked coordinated turns, sticky ground handling, rotation/liftoff, gear/flap/brake drag.
- **Runways** — grounded airport starts spawn you lined up on a drawn runway (centerline + edge stripes).
- **Glass-cockpit instruments** — live SVG six-pack: airspeed, attitude, altimeter, turn coordinator, heading, vertical speed, plus a throttle quadrant and a full HUD.
- **Four camera modes** — chase, cockpit, orbit, cinematic fly-by.
- **Controls** — full keyboard mapping **and** gamepad / joystick support.
- **Go anywhere** — pick from 12 real airports, drop into scenic spots (Grand Canyon, Everest, Manhattan, Golden Gate), or search any city / coordinates.
- **Day-night lighting**, time-of-day slider, quality settings, engine + wind audio.
- **Optional photorealistic upgrades** — paste a free Cesium ion token (3D terrain + OSM buildings) and/or a Google Maps API key (Google Photorealistic 3D Tiles) right in the app.

## Run it

```bash
npm install      # already done if you're reading this
npm run dev      # then open the printed http://127.0.0.1:5173
```

Build a static bundle to host anywhere:

```bash
npm run build && npm run preview
```

## Controls

| Keys | Action |
|------|--------|
| `W`/`S` or `↑`/`↓` | Pitch (push / pull) |
| `A`/`D` or `←`/`→` | Roll left / right |
| `Q`/`E` | Rudder yaw |
| `Shift`/`Ctrl` | Throttle up / down |
| `Z`/`X` | Throttle idle / full |
| `G` | Landing gear |
| `F`/`V` | Flaps down / up |
| `B` | Wheel brakes (hold) · `Space` parking brake |
| `[`/`]` | Trim |
| `C` | Cycle camera · `T` wing-leveler · `P` panel |
| `R` | Reset · `Esc` menu · `H` help |

**Take off:** release the parking brake (`Space`), throttle up (`Shift` or `X`),
let speed build to ~70 kt, then ease back (`S`/`↓`) to rotate. Gear up with `G`.

## Unlocking photorealistic Earth (optional)

Out of the box you get free ArcGIS satellite imagery + world terrain. To go further,
open **Menu → World** and paste either:

- **Cesium ion token** (free at <https://cesium.com/ion/>) → Cesium World Terrain + 3D OpenStreetMap buildings.
- **Google Maps API key** (with the *Map Tiles API* enabled) → full Google-Earth photorealistic 3D tiles.

Keys are stored only in your browser's `localStorage` and never leave your machine
except as direct requests to Cesium/Google.

## Project layout

```
src/
  main.js          orchestrator + game loop
  world.js         Cesium viewer, imagery/terrain/3D-tiles, lighting, ground sampling
  flightModel.js   point-mass flight dynamics
  aircraft.js      glTF model placement/orientation
  camera.js        chase / cockpit / orbit / fly-by rig
  input.js         keyboard + gamepad
  instruments.js   SVG cockpit gauges
  hud.js           heads-up display
  ui.js            menus, airport/aircraft pickers, search, settings
  audio.js         procedural engine + wind sound
  config.js        aircraft, airports, key bindings
  util.js          math helpers
public/assets/models/  aircraft glTF models
```

## Credits

- 3D aircraft models from the [Flightradar24 `fr24-3d-models`](https://github.com/Flightradar24/fr24-3d-models) project (GPLv2), converted from glTF 1.0 to glTF 2.0.
- Globe, imagery, terrain and 3D-tiles rendering by [CesiumJS](https://cesium.com/) (Apache-2.0).
- Default imagery & terrain: Esri World Imagery and World Elevation.

## Notes & limits

- Free ArcGIS imagery/terrain is generously available but rate-limited; for heavy use add your own keys.
- Ground collision uses Cesium's streamed terrain heights, so detection sharpens as tiles load in.
- This is an arcade-leaning flight model tuned for fun and stability — not a certified FDM. Swapping in JSBSim/WASM is a natural future step.
