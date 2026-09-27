import {
  ALT_KP,
  ALT_KV,
  DODGR_HARD_ALIGN,
  DODGR_HARD_POS_KP,
  DODGR_HARD_POS_KV,
  MAX_CLIMB_RATE,
  MAX_DESCENT_RATE,
  MAX_LATERAL_SPEED,
  MAX_TILT,
  MIN_COS_TILT,
  POS_KP,
  POS_KV,
  STATION_X,
} from './constants.ts';
import { densityRatio } from './atmosphere.ts';
import { availableThrust, clamp, lateralDrag, verticalDrag } from './physics.ts';
import { effectiveWind, rainLoad } from './weather.ts';
import type { DodgrDodgeMode, DroneState, PhysicsParams, PilotInput } from './types.ts';

export interface ControlOutput {
  throttle: number;
  rollCmd: number;
}

/**
 * Newtons the motors must produce along the airframe's up-axis to hit a target
 * vertical acceleration. Working in acceleration space is what keeps the loop
 * stable while the pilot retunes mass, gravity and peak thrust mid-flight.
 */
export function verticalDemand(
  drone: DroneState,
  params: PhysicsParams,
  targetAccel: number,
): number {
  const sigma = densityRatio(drone.y);
  return (
    params.mass * (params.gravity + targetAccel) -
    verticalDrag(drone.vy, params.rain, sigma) +
    rainLoad(params)
  );
}

/** Altitude error -> climb rate -> vertical acceleration. */
export function altitudeHold(drone: DroneState, params: PhysicsParams): number {
  return altitudeHoldTo(drone, params.targetAltitude);
}

/** Same cascade as cruise hold, aimed at an explicit altitude cap. */
export function altitudeHoldTo(drone: DroneState, targetY: number): number {
  const error = targetY - drone.y;
  const climbRate = clamp(error * ALT_KP, -MAX_DESCENT_RATE, MAX_CLIMB_RATE);
  return (climbRate - drone.vy) * ALT_KV;
}

/**
 * Peak lateral accel at MAX_TILT, using as much thrust as the air and the
 * pack can spare without asking for more than hover-at-tilt when that is
 * available. Sagged, thin-air, or weak motors fall back to whatever peak is
 * left (and will sink).
 */
export function maxLateralAccel(drone: DroneState, params: PhysicsParams): number {
  const peak = availableThrust(drone, params);
  const hover = params.mass * params.gravity;
  const cos = Math.max(Math.cos(MAX_TILT), MIN_COS_TILT);
  const tUsed = Math.min(peak, hover / cos);
  return (tUsed * Math.sin(MAX_TILT)) / Math.max(params.mass, 1e-6);
}

/**
 * Lateral error -> ground speed -> the roll angle whose thrust component
 * cancels the wind and walks the drone to the requested x. Defaults to the
 * pad centre; DODGR swaps in a lane centre instead.
 */
export function stationKeepTo(
  drone: DroneState,
  params: PhysicsParams,
  liftDemand: number,
  targetX: number,
): number {
  const error = targetX - drone.x;
  const groundSpeed = clamp(error * POS_KP, -MAX_LATERAL_SPEED, MAX_LATERAL_SPEED);
  const targetAccel = (groundSpeed - drone.vx) * POS_KV;
  const sigma = densityRatio(drone.y);
  const sideDemand =
    params.mass * targetAccel -
    lateralDrag(drone.vx, effectiveWind(drone, params), sigma);
  return clamp(
    Math.atan2(sideDemand, Math.max(liftDemand, 0.5)),
    -MAX_TILT,
    MAX_TILT,
  );
}

/** Legacy wrapper: cruise always walks home to the pad centre. */
export function stationKeep(
  drone: DroneState,
  params: PhysicsParams,
  liftDemand: number,
): number {
  return stationKeepTo(drone, params, liftDemand, STATION_X);
}

/** Convert a thrust demand into a throttle setting, undoing tilt lift loss. */
export function throttleForDemand(
  demand: number,
  roll: number,
  maxMotorThrust: number,
): number {
  const cosTilt = Math.max(Math.cos(roll), MIN_COS_TILT);
  return clamp(demand / cosTilt / Math.max(maxMotorThrust, 1e-9), 0, 1);
}

/**
 * Bang-bang strafe toward a lane: full ±MAX_TILT until braking distance,
 * then a high-gain station-keep that still saturates at MAX_TILT.
 * Does not cap at cruise MAX_LATERAL_SPEED — available accel does.
 */
function hardStrafeTo(
  drone: DroneState,
  params: PhysicsParams,
  liftDemand: number,
  targetX: number,
): number {
  const error = targetX - drone.x;
  const aLat = Math.max(maxLateralAccel(drone, params), 0.2);
  const stopDist = (drone.vx * drone.vx) / (2 * aLat);
  const toward = Math.sign(error);
  const vxToward = toward === 0 ? 0 : drone.vx * toward;

  if (toward !== 0 && vxToward > 0.15 && stopDist >= Math.abs(error) - 0.2) {
    return clamp(-toward * MAX_TILT, -MAX_TILT, MAX_TILT);
  }
  if (Math.abs(error) > DODGR_HARD_ALIGN) {
    return toward * MAX_TILT;
  }

  const groundSpeed = error * DODGR_HARD_POS_KP;
  const targetAccel = (groundSpeed - drone.vx) * DODGR_HARD_POS_KV;
  const sigma = densityRatio(drone.y);
  const sideDemand =
    params.mass * targetAccel -
    lateralDrag(drone.vx, effectiveWind(drone, params), sigma);
  return clamp(
    Math.atan2(sideDemand, Math.max(liftDemand, 0.5)),
    -MAX_TILT,
    MAX_TILT,
  );
}

/**
 * Cruise mode. Holds target altitude and station-keeps to pad centre, but
 * yields either axis for as long as the pilot is actually holding it.
 */
export function cruiseControl(
  drone: DroneState,
  params: PhysicsParams,
  input: PilotInput,
): ControlOutput {
  const targetAccel = altitudeHold(drone, params);
  const liftDemand = verticalDemand(drone, params, targetAccel);
  const peak = availableThrust(drone, params);

  return {
    throttle: input.throttleActive
      ? drone.throttle
      : throttleForDemand(liftDemand, drone.roll, peak),
    rollCmd: input.rollActive
      ? drone.rollCmd
      : stationKeep(drone, params, liftDemand),
  };
}

/**
 * DODGR autopilot. Chases the planner's dodgeAltitude (climb, duck, or
 * hold-under pocket). Lateral hardDodge only when the planner asked for it.
 * Throttle still goes through throttleForDemand so physics/battery see real T.
 */
export function dodgrControl(
  drone: DroneState,
  params: PhysicsParams,
  input: PilotInput,
  targetX: number,
  mode: DodgrDodgeMode = 'cruise',
  dodgeAltitude: number = Number.POSITIVE_INFINITY,
): ControlOutput {
  const targetY = Number.isFinite(dodgeAltitude)
    ? dodgeAltitude
    : params.targetAltitude;
  const targetAccel = altitudeHoldTo(drone, targetY);
  const liftDemand = verticalDemand(drone, params, targetAccel);
  const peak = availableThrust(drone, params);
  const rollCmd = input.rollActive
    ? drone.rollCmd
    : mode === 'hardDodge'
      ? hardStrafeTo(drone, params, liftDemand, targetX)
      : stationKeepTo(drone, params, liftDemand, targetX);

  return {
    throttle: input.throttleActive
      ? drone.throttle
      : throttleForDemand(liftDemand, drone.roll, peak),
    rollCmd,
  };
}
