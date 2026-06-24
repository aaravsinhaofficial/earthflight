// Visual effects — currently a particle-system explosion for crashes.
import * as Cesium from 'cesium';

function makeFireTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, 'rgba(255,255,235,1)');
  g.addColorStop(0.3, 'rgba(255,190,60,1)');
  g.addColorStop(0.6, 'rgba(225,70,15,0.85)');
  g.addColorStop(1.0, 'rgba(40,15,8,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return c.toDataURL();
}

function makeSmokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, 'rgba(90,90,90,0.9)');
  g.addColorStop(0.6, 'rgba(50,50,50,0.5)');
  g.addColorStop(1.0, 'rgba(20,20,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return c.toDataURL();
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.fireTex = makeFireTexture();
    this.smokeTex = makeSmokeTexture();
    this._active = [];
    this._scratch = new Cesium.Cartesian3();
  }

  // gravity + drag so particles arc and slow
  _gravity(p, dt) {
    Cesium.Cartesian3.normalize(p.position, this._scratch);          // local "up" (ECEF radial)
    Cesium.Cartesian3.multiplyByScalar(this._scratch, -9.8 * dt, this._scratch);
    Cesium.Cartesian3.add(p.velocity, this._scratch, p.velocity);
    Cesium.Cartesian3.multiplyByScalar(p.velocity, 1 - 0.7 * dt, p.velocity);
  }

  explode(position, size = 6) {
    const m = Cesium.Transforms.eastNorthUpToFixedFrame(position);
    const grav = (p, dt) => this._gravity(p, dt);

    const fire = new Cesium.ParticleSystem({
      image: this.fireTex,
      startColor: Cesium.Color.fromBytes(255, 230, 170, 255),
      endColor: Cesium.Color.fromBytes(80, 30, 10, 0),
      startScale: 1.0, endScale: 7.0,
      minimumParticleLife: 0.5, maximumParticleLife: 1.6,
      minimumSpeed: size * 1.5, maximumSpeed: size * 5,
      imageSize: new Cesium.Cartesian2(size, size),
      sizeInMeters: true,
      emissionRate: 0,
      bursts: [new Cesium.ParticleBurst({ time: 0.0, minimum: 140, maximum: 200 })],
      lifetime: 1.0, loop: false,
      emitter: new Cesium.SphereEmitter(size * 0.5),
      modelMatrix: m,
      updateCallback: grav,
    });

    const smoke = new Cesium.ParticleSystem({
      image: this.smokeTex,
      startColor: Cesium.Color.fromBytes(60, 60, 60, 220),
      endColor: Cesium.Color.fromBytes(30, 30, 30, 0),
      startScale: 2.0, endScale: 16.0,
      minimumParticleLife: 1.5, maximumParticleLife: 4.0,
      minimumSpeed: size * 0.6, maximumSpeed: size * 2.5,
      imageSize: new Cesium.Cartesian2(size * 1.5, size * 1.5),
      sizeInMeters: true,
      emissionRate: 60,
      bursts: [new Cesium.ParticleBurst({ time: 0.0, minimum: 40, maximum: 70 })],
      lifetime: 2.5, loop: false,
      emitter: new Cesium.SphereEmitter(size * 0.7),
      modelMatrix: m,
      updateCallback: grav,
    });

    this.scene.primitives.add(fire);
    this.scene.primitives.add(smoke);
    this._active.push({ ps: fire, ttl: 3.0 }, { ps: smoke, ttl: 7.0 });
  }

  update(dt) {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const a = this._active[i];
      a.ttl -= dt;
      if (a.ttl <= 0) {
        try { this.scene.primitives.remove(a.ps); } catch { /* ignore */ }
        this._active.splice(i, 1);
      }
    }
  }
}
