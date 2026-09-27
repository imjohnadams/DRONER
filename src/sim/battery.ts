import {
  BATTERY_ETA,
  BATTERY_HOVER_SECONDS,
  BATTERY_RESERVE_FRACTION,
  BATTERY_SAG_MIN,
  DEFAULT_PARAMS,
  ROTOR_DISK_AREA,
} from './constants.ts';
import type { DroneState, PhysicsParams } from './types.ts';

/** Sea-level density baked in for the pack sizing constant. */
const RHO_SL = 1.225;

/**
 * Ideal induced-power for a hovering rotor of area A producing thrust T in
 * still air at density rho: P = T^(3/2) / sqrt(2 * rho * A). Divide by the
 * combined motor/prop efficiency to get electrical draw.
 */
function inducedPower(thrust: number, density: number): number {
  if (thrust <= 0) return 0;
  const rho = Math.max(density, 1e-6);
  return Math.pow(thrust, 1.5) / Math.sqrt(2 * rho * ROTOR_DISK_AREA) / BATTERY_ETA;
}

/** Electrical power needed to hover at default params, W. */
const HOVER_POWER = inducedPower(
  DEFAULT_PARAMS.mass * DEFAULT_PARAMS.gravity,
  RHO_SL,
);

/**
 * Total pack capacity, joules. Sized so that after the locked reserve is set
 * aside the drone still gets BATTERY_HOVER_SECONDS of usable hover at the
 * default params, matching the comment in constants.ts.
 */
export const BATTERY_CAPACITY =
  (HOVER_POWER * BATTERY_HOVER_SECONDS) /
  Math.max(1e-6, 1 - BATTERY_RESERVE_FRACTION);

/** Absolute energy sitting below the "usable" line, joules. */
export const BATTERY_RESERVE_ENERGY = BATTERY_CAPACITY * BATTERY_RESERVE_FRACTION;

/** Total state of charge across the whole pack, 0..1. */
export function batterySoc(drone: DroneState): number {
  if (BATTERY_CAPACITY <= 0) return 0;
  return Math.max(0, Math.min(1, drone.batteryEnergy / BATTERY_CAPACITY));
}

/** Non-reserve state of charge, 0..1. This is what pilots actually spend. */
export function usableSoc(drone: DroneState): number {
  const usable = drone.batteryEnergy - BATTERY_RESERVE_ENERGY;
  const span = BATTERY_CAPACITY - BATTERY_RESERVE_ENERGY;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, usable / span));
}

/** Usable pack is exhausted; only the locked reserve is left (or nothing). */
function reserveOnly(drone: DroneState): boolean {
  return drone.batteryEnergy <= BATTERY_RESERVE_ENERGY + 1e-6;
}

/**
 * Main-flight brown-out: the pack cannot supply main flight anymore. Fail-safe
 * can still tap the reserve, so brown-out only latches when we are *not* in
 * fail-safe. This lets the HUD tell the two states apart.
 */
export function batteryBrownout(drone: DroneState): boolean {
  if (!drone.batteryEnabled) return false;
  return reserveOnly(drone) && !drone.failsafe;
}

/** Currently drawing from the reserve slice (only reachable during fail-safe). */
export function batteryInReserve(drone: DroneState): boolean {
  if (!drone.batteryEnabled) return false;
  return reserveOnly(drone) && drone.failsafe && drone.batteryEnergy > 0;
}

/**
 * Fraction of the nameplate thrust the pack can actually deliver right now.
 * Off pack: full authority. Empty pack: nothing. Between the two: linear
 * voltage sag from full down to BATTERY_SAG_MIN across the usable range.
 * The reserve slice is locked unless allowReserve is set (fail-safe only).
 */
export function batteryThrustScale(
  drone: DroneState,
  allowReserve: boolean,
): number {
  if (!drone.batteryEnabled) return 1;
  if (drone.batteryEnergy <= 0) return 0;
  if (reserveOnly(drone) && !allowReserve) return 0;
  const soc = usableSoc(drone);
  return BATTERY_SAG_MIN + (1 - BATTERY_SAG_MIN) * soc;
}

/** Peak thrust available right now, respecting pack sag / brown-out. */
export function effectiveMaxThrust(
  drone: DroneState,
  params: PhysicsParams,
): number {
  if (!drone.batteryEnabled) return params.maxMotorThrust;
  const scale = batteryThrustScale(drone, drone.failsafe);
  return params.maxMotorThrust * scale;
}

/** Spend energy for the thrust actually produced this step. */
export function drainBattery(
  drone: DroneState,
  thrust: number,
  density: number,
  dt: number,
): void {
  if (!drone.batteryEnabled) return;
  if (thrust <= 0 || dt <= 0) return;
  const power = inducedPower(thrust, density);
  drone.batteryEnergy = Math.max(0, drone.batteryEnergy - power * dt);
}

/**
 * Seconds of flight left at the current draw, or null when the answer is not
 * meaningful (pack disabled, idle, or already brown-out). Only counts the
 * usable slice so the HUD does not tease reserve time.
 */
export function remainingSeconds(
  drone: DroneState,
  thrust: number,
  density: number,
): number | null {
  if (!drone.batteryEnabled) return null;
  if (thrust <= 0.01) return null;
  const usable = drone.batteryEnergy - BATTERY_RESERVE_ENERGY;
  if (usable <= 0) return 0;
  const power = inducedPower(thrust, density);
  if (power <= 0) return null;
  return usable / power;
}
