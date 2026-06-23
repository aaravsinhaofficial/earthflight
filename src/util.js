// Small math helpers used across the sim.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate independent exponential smoothing toward `target`.
// rate ~ how fast (per second). dt in seconds.
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

// Wrap radians to [-PI, PI]
export function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
// Wrap degrees to [0, 360)
export function wrap360(d) {
  return ((d % 360) + 360) % 360;
}

// Unit conversions
export const mToFt = (m) => m * 3.280839895;
export const msToKt = (ms) => ms * 1.943844;
export const msToFpm = (ms) => ms * 196.8503937;

// Standard atmosphere air density (kg/m³) at geometric altitude h (m).
// Troposphere model up to 11 km, then a gentle exponential tail.
export function airDensity(h) {
  if (h < 11000) {
    const T = 288.15 - 0.0065 * h;
    return 1.225 * Math.pow(T / 288.15, 4.256);
  }
  // above the tropopause: exponential falloff anchored at 11 km
  const rho11 = 0.36391;
  return rho11 * Math.exp(-(h - 11000) / 6341.6);
}
