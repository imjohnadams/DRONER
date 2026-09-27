import {
  DRAG_X,
  GUST_ALT_SCALE,
  GUST_FRACTION,
  GUST_MAX_PERIOD,
  GUST_MIN_PERIOD,
  GUST_RESPONSE,
  MAX_TILT,
  PARAM_LIMITS,
  RAIN_DRAG_GAIN,
  RAIN_FALLBACK_FRACTION,
  RAIN_LOAD_FRACTION,
} from './constants.ts';
import type { DroneState, ParamKey, PhysicsParams } from './types.ts';

/**
 * Fastest wind the airframe can still hold station against, m/s. Solved from
 * the drag the motors can cancel at full tilt, so retuning thrust retunes the
 * wind slider with it.
 */
export function windLimit(params: PhysicsParams): number {
  const side = Math.max(params.maxMotorThrust, 0) * Math.sin(MAX_TILT);
  return Math.sqrt(side / DRAG_X);
}

/** Working range for a slider, resolved against the current params. */
export function paramBounds(
  key: ParamKey,
  params: PhysicsParams,
): { min: number; max: number } {
  if (key !== 'wind') return PARAM_LIMITS[key];
  const limit = windLimit(params);
  return { min: -limit, max: limit };
}

/**
 * Downward newtons the rain piles onto the airframe. A full downpour spends
 * most of the leftover hover margin, so it always hurts without being an
 * automatic loss. With no margin at all it falls back to a share of weight.
 */
export function rainLoad(params: PhysicsParams): number {
  if (params.rain <= 0) return 0;
  const weight = params.mass * params.gravity;
  const margin = params.maxMotorThrust - weight;
  const base =
    margin > 1e-6
      ? margin * RAIN_LOAD_FRACTION
      : weight * RAIN_FALLBACK_FRACTION;
  return params.rain * base;
}

/** Vertical drag multiplier: wet air is thicker to fall through. */
export function rainDragScale(rain: number): number {
  return 1 + Math.max(rain, 0) * RAIN_DRAG_GAIN;
}

/** Roughly 0 on the pad, approaching 1 well above the warehouse. */
export function gustAltitudeFactor(altitude: number): number {
  return 1 - Math.exp(-Math.max(altitude, 0) / GUST_ALT_SCALE);
}

/** Strongest gust the current turbulence setting can throw, m/s. */
export function peakGust(params: PhysicsParams): number {
  return params.turbulence * windLimit(params) * GUST_FRACTION;
}

/** Advance the gust state one physics step: random bursts that rise and decay. */
export function updateGust(
  drone: DroneState,
  params: PhysicsParams,
  dt: number,
): void {
  const amplitude = peakGust(params) * gustAltitudeFactor(drone.y);

  drone.gustTimer -= dt;
  if (drone.gustTimer <= 0) {
    drone.gustTimer =
      GUST_MIN_PERIOD + Math.random() * (GUST_MAX_PERIOD - GUST_MIN_PERIOD);
    drone.gustTarget = (Math.random() * 2 - 1) * amplitude;
  }

  // The ceiling can drop under the target when the drone descends.
  if (drone.gustTarget > amplitude) drone.gustTarget = amplitude;
  else if (drone.gustTarget < -amplitude) drone.gustTarget = -amplitude;

  drone.gust += (drone.gustTarget - drone.gust) * Math.min(1, GUST_RESPONSE * dt);
}

/** Air speed the airframe actually feels: the slider plus the live gust. */
export function effectiveWind(drone: DroneState, params: PhysicsParams): number {
  return params.wind + drone.gust;
}
