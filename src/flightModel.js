// Point-mass flight dynamics model.
//
// State is energy/attitude based (a well-proven approach for stable sims):
//   - V      true airspeed (m/s)
//   - gamma  flight-path angle (climb angle, rad)
//   - heading, roll, pitch (rad)         pitch = gamma + angle-of-attack
//   - alpha  angle of attack (rad), driven by the elevator
//   - position: lon/lat (rad), height (m above ellipsoid ≈ MSL)
//
// Ground contact is "sticky": once on the runway the aircraft stays glued there
// (wings level, no vertical motion) until it is fast enough AND pulling enough
// lift to rotate. This prevents the near-zero-airspeed gamma blow-up that made
// the plane nose-dive off the runway.

import { clamp, damp, wrapPi, wrap360, airDensity, DEG } from './util.js';

const G = 9.80665;
const R_EARTH = 6378137;
const RHO0 = 1.225;

export class FlightModel {
  constructor(aircraft) {
    this.setAircraft(aircraft);
    this.reset({ lon: 0, lat: 0, height: 0, heading: 0 });
  }

  setAircraft(ac) {
    this.ac = ac;
    this.alphaStall = (ac.clMax - ac.cl0) / ac.clAlpha; // rad
    this.vRotate = ac.stallSpeed * 1.08;                // m/s, rotation speed
  }

  reset({ lon, lat, height, heading, airborne }) {
    this.lon = lon * DEG;
    this.lat = lat * DEG;
    this.height = height;
    this.heading = heading * DEG;
    this.roll = 0;
    this.alpha = 2 * DEG;
    this.gamma = 0;
    this.pitch = airborne ? 0 : 2 * DEG;
    this.trim = 0;

    this.throttle = airborne ? 0.6 : 0;
    this.flaps = 0;
    this.gearDown = true;
    this.parkingBrake = !airborne;
    this.wheelBrake = false;
    this.autopilotLevel = false;

    this.V = airborne ? 80 : 0;
    this.onGround = !airborne;
    this.verticalSpeed = 0;
    this.groundSpeed = this.V;
    this.loadFactor = 1;
    this.stalled = false;
    this.crashed = false;
    // `height` is the MSL altitude. Seed terrain just under the wheels so the
    // first frame reads "on ground" cleanly; real terrain replaces it as it streams.
    this.terrainHeight = airborne ? height - 500 : height - this.ac.wheelHeight;
  }

  // controls: { pitch:-1..1, roll:-1..1, yaw:-1..1 }  (yaw = rudder)
  // env: { terrainHeight }  meters at current lon/lat
  update(dt, controls, env) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.05);
    const ac = this.ac;
    this.terrainHeight = env.terrainHeight;
    const groundH = this.terrainHeight + ac.wheelHeight;

    const rho = airDensity(this.height);
    const q = 0.5 * rho * this.V * this.V;
    const thrust = this.throttle * ac.maxThrust * (rho / RHO0);
    const weight = ac.mass * G;

    // =====================================================================
    //  ATTITUDE  (roll auto-levels; alpha follows the elevator)
    // =====================================================================
    const rollAuth = clamp(this.V / (ac.stallSpeed * 1.1), 0.25, 1);
    if (Math.abs(controls.roll) > 0.04) {
      this.roll += controls.roll * ac.rollRate * rollAuth * dt;
    } else {
      // positive roll stability — wings return to level when you let go
      this.roll = damp(this.roll, 0, this.autopilotLevel ? 2.5 : 1.4, dt);
    }
    this.roll = clamp(this.roll, -75 * DEG, 75 * DEG);

    const pitchAuth = clamp(this.V / (ac.stallSpeed * 1.2), 0.4, 1);
    const elevator = clamp(controls.pitch + this.trim, -1, 1) * pitchAuth;
    const alphaCmd = clamp(2 * DEG + elevator * 13 * DEG, -6 * DEG, this.alphaStall + 5 * DEG);
    this.alpha = damp(this.alpha, alphaCmd, 8, dt);

    // =====================================================================
    //  AERODYNAMICS
    // =====================================================================
    let cl = ac.cl0 + ac.clAlpha * this.alpha + ac.flapClBonus * this.flaps;
    this.stalled = this.alpha > this.alphaStall && !this.onGround;
    if (this.stalled) {
      const over = this.alpha - this.alphaStall;
      cl = ac.clMax * Math.max(0.4, 1 - over * 3.0);
    } else {
      cl = clamp(cl, -ac.clMax, ac.clMax);
    }
    const cd = ac.cd0 + ac.inducedK * cl * cl
             + ac.flapDrag * this.flaps
             + (this.gearDown ? ac.gearDrag : 0)
             + (this.stalled ? 0.08 : 0);
    const lift = q * ac.wingArea * cl;
    const drag = q * ac.wingArea * cd;
    this.loadFactor = lift / weight;

    // =====================================================================
    //  GROUND (sticky) vs AIRBORNE
    // =====================================================================
    if (this.onGround) {
      this.height = groundH;
      this.gamma = 0;
      this.verticalSpeed = 0;
      this.roll = damp(this.roll, 0, 8, dt);   // wings level on the wheels
      // nose follows the elevator-driven AoA once rolling fast enough to rotate
      const fast = this.V > this.vRotate * 0.6;
      this.pitch = damp(this.pitch, fast ? clamp(this.alpha, 0, 12 * DEG) : 1.5 * DEG, 6, dt);

      // longitudinal: thrust vs drag, rolling resistance & brakes
      let resist = 0.025 * weight;
      if (this.wheelBrake) resist += 0.4 * weight;
      if (this.parkingBrake) resist += 0.8 * weight;
      const along = thrust - drag - Math.sign(this.V) * Math.min(resist, Math.abs(thrust - drag) + resist);
      this.V += (along / ac.mass) * dt;
      if (this.V < 0) this.V = 0;
      if ((this.parkingBrake || this.wheelBrake) && this.V < 0.3) this.V = 0;

      // nose-wheel / rudder steering, scales with speed
      const steer = controls.yaw * ac.yawRate * clamp(this.V / 8, 0, 1.2);
      this.heading = wrapPi(this.heading + steer * dt);

      // rotate when fast enough and generating enough lift. Impart a real climb
      // and clear the wheels so the same-frame touchdown check can't re-ground us.
      if (this.V > this.vRotate && lift >= weight * 0.95) {
        this.onGround = false;
        this.gamma = 3 * DEG;
        this.verticalSpeed = this.V * Math.sin(this.gamma);
        this.height = groundH + 0.6;
      }
    } else {
      const Vsafe = Math.max(this.V, 22);  // floor avoids low-speed gamma blow-up

      const dV = (thrust * Math.cos(this.alpha) - drag - weight * Math.sin(this.gamma)) / ac.mass;
      this.V = clamp(this.V + dV * dt, 0, ac.vne * 1.4);

      const dGamma = (lift * Math.cos(this.roll) + thrust * Math.sin(this.alpha) - weight * Math.cos(this.gamma)) / (ac.mass * Vsafe);
      this.gamma = clamp(this.gamma + dGamma * dt, -80 * DEG, 80 * DEG);

      const turnRate = (lift * Math.sin(this.roll)) / (ac.mass * Vsafe * Math.max(Math.cos(this.gamma), 0.3));
      const rudder = controls.yaw * ac.yawRate * 0.4 * rollAuth;
      this.heading = wrapPi(this.heading + (turnRate + rudder) * dt);

      this.pitch = this.gamma + this.alpha;
      this.verticalSpeed = this.V * Math.sin(this.gamma);
    }

    // =====================================================================
    //  POSITION INTEGRATION (geodetic)
    // =====================================================================
    const u = this.V * Math.cos(this.gamma);
    const vN = u * Math.cos(this.heading);
    const vE = u * Math.sin(this.heading);
    this.lat += (vN * dt) / (R_EARTH + this.height);
    this.lon += (vE * dt) / ((R_EARTH + this.height) * Math.cos(this.lat));
    this.groundSpeed = u;

    if (!this.onGround) {
      this.height += this.verticalSpeed * dt;
      if (this.height <= groundH) {
        // reached the ground — touchdown only counts when actually descending
        const sink = -this.verticalSpeed;
        this.height = groundH;
        this.onGround = true;
        this.gamma = 0;
        this.verticalSpeed = 0;
        if (sink > 9 || this.loadFactor > 4) this.crashed = true; // hard arrival
      }
    }
  }

  // ── control inputs ────────────────────────────────────────────────────────
  addThrottle(d) { this.throttle = clamp(this.throttle + d, 0, 1); }
  setThrottle(v) { this.throttle = clamp(v, 0, 1); }
  addFlaps(d)    { this.flaps = clamp(this.flaps + d, 0, 1); }
  toggleGear()   { if (!this.onGround) this.gearDown = !this.gearDown; }
  toggleParking(){ this.parkingBrake = !this.parkingBrake; }
  addTrim(d)     { this.trim = clamp(this.trim + d, -0.6, 0.6); }
  toggleAP()     { this.autopilotLevel = !this.autopilotLevel; }

  // ── readouts ──────────────────────────────────────────────────────────────
  get headingDeg() { return wrap360(this.heading / DEG); }
  get aoaDeg() { return this.alpha / DEG; }
  get agl() { return this.height - this.terrainHeight; }
  get cartographicDeg() {
    return { lon: this.lon / DEG, lat: this.lat / DEG, height: this.height };
  }
}
