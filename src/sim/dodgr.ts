/**
 * DODGR mini-game.
 *
 * A 3-lane climb-and-dodge on top of the same rigid body + weather sim.
 * The module owns:
 *   - obstacle spawning + motion + collision
 *   - a difficulty curve keyed off altitude
 *   - a weather profile it writes into the real PhysicsParams sliders
 *   - a lane picker the autopilot uses in place of station-keeping
 *
 * The drone still uses continuous x. Lanes only shape spawn placement and
 * feed the autopilot a strafe target. Everything writes through the same
 * `setParam` path the sliders use so change tabs and telemetry stay honest.
 */

import {
  DODGR_BRANCH_MIN_GAP,
  DODGR_COMMIT_ARRIVE,
  DODGR_COMMIT_CLEAR_TIME,
  DODGR_DIFFICULTY_SCALE,
  DODGR_DRONE_HALF_H,
  DODGR_DRONE_HALF_W,
  DODGR_ENV_RATE,
  DODGR_ENV_STEP,
  DODGR_HARD_ALIGN,
  DODGR_HARD_THREAT_TIME,
  DODGR_HOLD_UNDER_MARGIN,
  DODGR_HOLD_UNDER_MID,
  DODGR_LANE_WIDTH,
  DODGR_LANE_X,
  DODGR_LOOKAHEAD_MAX,
  DODGR_LOOKAHEAD_MIN,
  DODGR_LOOKAHEAD_PAD,
  DODGR_MAX_RAIN,
  DODGR_MAX_TURBULENCE,
  DODGR_SPAWN_MAX,
  DODGR_SPAWN_MIN,
  DODGR_VERT_DODGE_MARGIN,
  DODGR_WEATHER_SCALE,
  DODGR_WEATHER_START,
  DODGR_WIND_FRACTION,
  DODGR_WIND_RATE,
  DODGR_WIND_STEP,
  MAX_CLIMB_RATE,
  MAX_DESCENT_RATE,
  MAX_TILT,
  ROLL_RATE_LIMIT,
  VIEW_FOLLOW,
  VIEW_HEIGHT,
  WORLD,
} from './constants.ts';
import { maxLateralAccel } from './autopilot.ts';
import { clamp, groundLevelAt } from './physics.ts';
import { windLimit } from './weather.ts';
import type { DodgrDodgeMode, DroneState, ParamKey, PhysicsParams } from './types.ts';

export type ObstacleKind = 'branch' | 'bird' | 'plane' | 'drop';

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  /** World coordinates of the centre. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Axis-aligned half extents used for collision + lane occupancy. */
  halfWidth: number;
  halfHeight: number;
  /** Bitmask of lanes this thing currently occupies. Bit i = lane i. */
  lanes: number;
  /** Sim clock at spawn, seconds. */
  born: number;
  /** Optional lifetime; crossers set this so they cannot linger off-screen. */
  ttl: number | null;
}

/** Per-slider lock: once the pilot drags it, DODGR stops driving that key. */
export interface WeatherLatch {
  wind: boolean;
  rain: boolean;
  turbulence: boolean;
}

export interface DodgrState {
  active: boolean;
  /** Latched WIN state; hover-and-dodge until targetAltitude is raised. */
  won: boolean;
  /** Sim clock, seconds since activation. */
  runElapsed: number;
  /** Countdown until the next spawn attempt, seconds. */
  spawnTimer: number;
  obstacles: Obstacle[];
  nextId: number;
  /** Lane index the autopilot is aiming for right now. */
  targetLane: number;
  /** Dodge lane held until the forcing threats clear, or null when idle. */
  committedLane: number | null;
  /** Survival mode consumed by dodgrControl this tick. */
  dodgeMode: DodgrDodgeMode;
  /** Altitude the autopilot chases this tick. */
  dodgeAltitude: number;
  /** Lateral station target; branch centre while holding under a log. */
  holdTargetX: number;
  /** Altitude cap while holding under a branch; Infinity when unused. */
  holdCeiling: number;
  /** Sliders the game is still allowed to drive. */
  drives: WeatherLatch;
  /** Peak altitude reached during this run. */
  peakAltitude: number;
  /** Altitude the WIN was latched at, for the HUD banner. */
  winAltitude: number;
}

export const DODGR_LANE_COUNT = DODGR_LANE_X.length;
/** How close to a lane centre still counts as "safe" for occupancy tests. */
const LANE_OCC_HALF = DODGR_DRONE_HALF_W + 0.25;

export function createDodgrState(): DodgrState {
  return {
    active: false,
    won: false,
    runElapsed: 0,
    spawnTimer: 0,
    obstacles: [],
    nextId: 1,
    targetLane: 1,
    committedLane: null,
    dodgeMode: 'cruise',
    dodgeAltitude: 0,
    holdTargetX: 0,
    holdCeiling: Number.POSITIVE_INFINITY,
    drives: { wind: true, rain: true, turbulence: true },
    peakAltitude: 0,
    winAltitude: 0,
  };
}

/** Deep-clear back to a fresh idle state. Used on Reset and toggle-off. */
export function clearDodgr(state: DodgrState): void {
  state.active = false;
  state.won = false;
  state.runElapsed = 0;
  state.spawnTimer = 0;
  state.obstacles.length = 0;
  state.nextId = 1;
  state.targetLane = 1;
  state.committedLane = null;
  state.dodgeMode = 'cruise';
  state.dodgeAltitude = 0;
  state.holdTargetX = 0;
  state.holdCeiling = Number.POSITIVE_INFINITY;
  state.drives = { wind: true, rain: true, turbulence: true };
  state.peakAltitude = 0;
  state.winAltitude = 0;
}

/** 0 near the pad, approaching 1 at high altitude. */
export function difficulty(altitude: number): number {
  return 1 - Math.exp(-Math.max(altitude, 0) / DODGR_DIFFICULTY_SCALE);
}

/** Lane index whose centre is closest to a given x. */
export function laneAt(x: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < DODGR_LANE_COUNT; i += 1) {
    const d = Math.abs(x - DODGR_LANE_X[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export function laneCentre(lane: number): number {
  return DODGR_LANE_X[clamp(lane, 0, DODGR_LANE_COUNT - 1) | 0];
}

/** Bitmask of lanes an axis-aligned box at (x, halfWidth) covers. */
function computeLaneMask(x: number, halfWidth: number): number {
  let mask = 0;
  for (let i = 0; i < DODGR_LANE_COUNT; i += 1) {
    if (Math.abs(x - DODGR_LANE_X[i]) < halfWidth + LANE_OCC_HALF) {
      mask |= 1 << i;
    }
  }
  return mask;
}

/** Top of the camera window in world-y for the current drone altitude. */
function viewTop(droneY: number): number {
  const bottom = Math.max(0, droneY - VIEW_HEIGHT * VIEW_FOLLOW);
  return bottom + VIEW_HEIGHT;
}

/** Bottom of the camera window in world-y. */
function viewBottom(droneY: number): number {
  return Math.max(0, droneY - VIEW_HEIGHT * VIEW_FOLLOW);
}

/**
 * Build one obstacle. Returns null when fairness rules reject the spawn
 * (blocked corridor, branch too close to another, etc.).
 */
function rollObstacle(
  state: DodgrState,
  drone: DroneState,
  d: number,
): Obstacle | null {
  const roll = Math.random();
  let kind: ObstacleKind;
  if (state.won) {
    // On WIN we hover; branches above the drone would never be reached and
    // static obstacles look wrong. Prefer things that fly at the drone.
    kind = roll < 0.55 ? 'drop' : roll < 0.8 ? 'bird' : 'plane';
  } else if (roll < 0.28) {
    kind = 'branch';
  } else if (roll < 0.55 + 0.15 * d) {
    kind = 'drop';
  } else if (roll < 0.82) {
    kind = 'bird';
  } else {
    kind = 'plane';
  }

  // Branches only use left/right; other kinds may use any lane.
  const laneIdx =
    kind === 'branch'
      ? Math.random() < 0.5
        ? 0
        : DODGR_LANE_COUNT - 1
      : Math.floor(Math.random() * DODGR_LANE_COUNT);
  const laneX = DODGR_LANE_X[laneIdx];

  const spawnAhead = state.won
    ? 0
    : VIEW_HEIGHT * (1 - VIEW_FOLLOW) + 4 + Math.random() * 6;
  const baseY = drone.y + spawnAhead;

  if (kind === 'branch') {
    // Single-lane only on left or right — never the middle corridor.
    const halfWidth = DODGR_LANE_WIDTH * 0.32;
    const x = laneX;
    const mask = computeLaneMask(x, halfWidth);
    if (branchesTooClose(state, baseY)) return null;
    // Fairness: never let branches at the same altitude band block all lanes.
    if (branchesBlockAll(state, baseY, mask)) return null;
    return {
      id: state.nextId++,
      kind,
      x,
      y: baseY,
      vx: 0,
      vy: 0,
      halfWidth,
      halfHeight: 0.4,
      lanes: mask,
      born: state.runElapsed,
      ttl: null,
    };
  }

  if (kind === 'drop') {
    const speed = 3.5 + 5 * d + Math.random() * 2.5;
    const halfWidth = 0.55 + Math.random() * 0.2;
    const y = state.won
      ? viewTop(drone.y) + 2 + Math.random() * 4
      : baseY + 3 + Math.random() * 3;
    return {
      id: state.nextId++,
      kind,
      x: laneX,
      y,
      vx: 0,
      vy: -speed,
      halfWidth,
      halfHeight: 0.55,
      lanes: computeLaneMask(laneX, halfWidth),
      born: state.runElapsed,
      ttl: null,
    };
  }

  // Bird / plane cross horizontally.
  const dir = Math.random() < 0.5 ? -1 : 1;
  const speed = kind === 'bird' ? 4.5 + 3.5 * d : 8 + 5 * d;
  const halfWidth = kind === 'bird' ? 0.55 : 1.5;
  const halfHeight = kind === 'bird' ? 0.4 : 0.5;
  // Enter one wall's worth off-screen so the crossing looks intentional.
  const startX = -dir * (WORLD.halfWidth + halfWidth + 0.6);
  const y = state.won
    ? drone.y + (Math.random() - 0.5) * 1.4
    : baseY - Math.random() * 3;
  const ttl = ((WORLD.halfWidth + halfWidth) * 2 + 2) / speed + 0.5;
  return {
    id: state.nextId++,
    kind,
    x: startX,
    y,
    vx: dir * speed,
    vy: 0,
    halfWidth,
    halfHeight,
    lanes: computeLaneMask(startX, halfWidth),
    born: state.runElapsed,
    ttl,
  };
}

/** True if adding this branch would join others to cover every lane at this y. */
function branchesBlockAll(state: DodgrState, y: number, mask: number): boolean {
  const band = 1.6;
  let combined = mask;
  for (const o of state.obstacles) {
    if (o.kind !== 'branch') continue;
    if (Math.abs(o.y - y) > band) continue;
    combined |= o.lanes;
  }
  return combined === (1 << DODGR_LANE_COUNT) - 1;
}

/** True if another branch is already within the minimum vertical gap. */
function branchesTooClose(state: DodgrState, y: number): boolean {
  for (const o of state.obstacles) {
    if (o.kind !== 'branch') continue;
    if (Math.abs(o.y - y) < DODGR_BRANCH_MIN_GAP) return true;
  }
  return false;
}

/** Seconds until we try to spawn again, tapered by difficulty. */
function spawnInterval(d: number): number {
  return DODGR_SPAWN_MAX + (DODGR_SPAWN_MIN - DODGR_SPAWN_MAX) * d;
}

/**
 * Weather intensity: calm until DODGR_WEATHER_START, then ramps with altitude.
 * Separate from spawn difficulty so the climb game still heats up early.
 */
export function weatherIntensity(altitude: number): number {
  const excess = Math.max(0, altitude - DODGR_WEATHER_START);
  if (excess <= 0) return 0;
  return 1 - Math.exp(-excess / DODGR_WEATHER_SCALE);
}

/** Where the weather sliders should be heading right now. */
export function targetWeather(
  altitude: number,
  params: PhysicsParams,
  runElapsed: number,
): { wind: number; rain: number; turbulence: number } {
  const d = weatherIntensity(altitude);
  const limit = windLimit(params);
  // A slow sinusoidal swing on top of altitude scaling so hugging one wall
  // stops being free: the wind eventually turns and pushes back.
  const swing = Math.sin(runElapsed * 0.18 + altitude * 0.04);
  const wind = clamp(swing * d * limit * DODGR_WIND_FRACTION, -limit, limit);
  const rain = clamp(d * DODGR_MAX_RAIN, 0, 1);
  const turbulence = clamp(d * DODGR_MAX_TURBULENCE, 0, 1);
  return { wind, rain, turbulence };
}

/** Advance a single slider one dt toward its target at a linear rate. */
function approachScalar(current: number, target: number, rate: number, dt: number): number {
  const delta = target - current;
  const step = rate * dt;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

/** Push the weather target through the real setParam pipe (for change tabs). */
function driveWeather(
  state: DodgrState,
  drone: DroneState,
  params: PhysicsParams,
  setParam: (key: ParamKey, value: number) => void,
  dt: number,
): void {
  const target = targetWeather(drone.y, params, state.runElapsed);

  if (state.drives.wind) {
    const next = approachScalar(params.wind, target.wind, DODGR_WIND_RATE, dt);
    if (Math.abs(next - params.wind) >= DODGR_WIND_STEP) setParam('wind', next);
  }
  if (state.drives.rain) {
    const next = approachScalar(params.rain, target.rain, DODGR_ENV_RATE, dt);
    if (Math.abs(next - params.rain) >= DODGR_ENV_STEP) setParam('rain', next);
  }
  if (state.drives.turbulence) {
    const next = approachScalar(
      params.turbulence,
      target.turbulence,
      DODGR_ENV_RATE,
      dt,
    );
    if (Math.abs(next - params.turbulence) >= DODGR_ENV_STEP) {
      setParam('turbulence', next);
    }
  }
}

/**
 * Called from a WeatherRow / setParam wrapper when the user physically drags
 * a slider. Latches DODGR off that key until the game is toggled off/on.
 */
export function noteManualParam(state: DodgrState, key: ParamKey): void {
  if (!state.active) return;
  if (key === 'wind') state.drives.wind = false;
  else if (key === 'rain') state.drives.rain = false;
  else if (key === 'turbulence') state.drives.turbulence = false;
}

/** AABB overlap between the drone body and an obstacle. */
function collides(drone: DroneState, o: Obstacle): boolean {
  return (
    Math.abs(o.x - drone.x) < o.halfWidth + DODGR_DRONE_HALF_W &&
    Math.abs(o.y - drone.y) < o.halfHeight + DODGR_DRONE_HALF_H
  );
}

/** Seconds until the AABBs share a vertical band, or null if not a threat. */
export function timeToMeet(o: Obstacle, drone: DroneState): number | null {
  if (o.vy < 0) {
    const topOfDrone = drone.y + DODGR_DRONE_HALF_H;
    const bottomOfDrone = drone.y - DODGR_DRONE_HALF_H;
    const bottomOfDrop = o.y - o.halfHeight;
    const topOfDrop = o.y + o.halfHeight;
    // Fully below the airframe — no longer a threat.
    if (topOfDrop < bottomOfDrone - 0.15) return null;

    const sep = bottomOfDrop - topOfDrone;
    if (sep > 0) {
      const closing = -o.vy + Math.max(drone.vy, 0);
      if (closing <= 0.05) return null;
      return sep / closing;
    }

    // Already in (or past) the altitude band: stay a threat until clear below.
    const xGap = Math.abs(o.x - drone.x) - o.halfWidth - DODGR_DRONE_HALF_W;
    if (xGap <= 0) return 0;
    // Beside us but still overlapping in Y — treat as imminent; do not ignore.
    const clearDown = topOfDrop - bottomOfDrone;
    const fallClear = clearDown / Math.max(-o.vy, 0.2);
    return Math.min(0.45, Math.max(0.05, fallClear));
  }

  const sep = o.y - o.halfHeight - (drone.y + DODGR_DRONE_HALF_H);
  if (sep > 0) {
    const climb = Math.max(drone.vy, 0.35);
    return sep / climb;
  }

  const overlappingY =
    Math.abs(o.y - drone.y) < o.halfHeight + DODGR_DRONE_HALF_H + 0.45;
  if (overlappingY && Math.abs(o.vx) > 0.1) {
    return timeToLateralMeet(o, drone);
  }
  return null;
}

function timeToLateralMeet(o: Obstacle, drone: DroneState): number {
  const sep = Math.abs(o.x - drone.x) - o.halfWidth - DODGR_DRONE_HALF_W;
  if (sep <= 0) return 0;
  const relVx = o.vx - drone.vx;
  const closing = o.x > drone.x ? -relVx : relVx;
  if (closing > 0.05) return sep / closing;
  return sep / Math.max(Math.abs(o.vx), 0.2);
}

/** Bang-coast time to a target x, plus roll-servo lag. */
export function strafeTime(
  fromX: number,
  vx: number,
  toX: number,
  aLat: number,
): number {
  const a = Math.max(aLat, 0.08);
  const d = toX - fromX;
  const rollLag = MAX_TILT / Math.max(ROLL_RATE_LIMIT, 0.1);
  if (Math.abs(d) < 1e-4 && Math.abs(vx) < 0.05) return rollLag;

  let motion: number;
  if (d * vx < 0) {
    const extra = (vx * vx) / (2 * a);
    motion = Math.abs(vx) / a + 2 * Math.sqrt((Math.abs(d) + extra) / a);
  } else {
    const dAbs = Math.abs(d);
    const v = Math.abs(vx);
    const stopDist = (v * v) / (2 * a);
    if (stopDist >= dAbs) {
      motion = v / a;
    } else {
      const dAcc = (dAbs - stopDist) / 2;
      const vPeak = Math.sqrt(v * v + 2 * a * Math.max(dAcc, 0));
      motion = (vPeak - v) / a + vPeak / a;
    }
  }
  return motion + rollLag;
}

function lookAheadHorizon(drone: DroneState, params: PhysicsParams): number {
  const aLat = maxLateralAccel(drone, params);
  const left = strafeTime(drone.x, drone.vx, DODGR_LANE_X[0], aLat);
  const right = strafeTime(
    drone.x,
    drone.vx,
    DODGR_LANE_X[DODGR_LANE_COUNT - 1],
    aLat,
  );
  return clamp(
    Math.max(left, right) + DODGR_LOOKAHEAD_PAD,
    DODGR_LOOKAHEAD_MIN,
    DODGR_LOOKAHEAD_MAX,
  );
}

function occupancyMask(o: Obstacle, time: number): number {
  let mask = o.lanes;
  if (Math.abs(o.vx) > 0.1) {
    mask |= computeLaneMask(o.x + o.vx * Math.max(time, 0), o.halfWidth);
  }
  return mask;
}

function isWaitableBranch(o: Obstacle, drone: DroneState): boolean {
  if (o.kind !== 'branch') return false;
  const sep = o.y - o.halfHeight - (drone.y + DODGR_DRONE_HALF_H);
  return sep > DODGR_HOLD_UNDER_MARGIN;
}

function threatWeight(o: Obstacle, time: number): number {
  let w = 1 / (0.28 + time);
  if (o.kind === 'drop') w *= 2.2;
  else if (o.kind === 'plane') w *= 1.2;
  else if (o.kind === 'bird') w *= 1.1;
  return w;
}

/** Soonest inbound drop on any lane, or Infinity. */
function soonestDropTime(
  state: DodgrState,
  drone: DroneState,
  horizon: number,
): number {
  let best = Infinity;
  for (const o of state.obstacles) {
    if (o.kind !== 'drop' && !(o.vy < 0)) continue;
    const time = timeToMeet(o, drone);
    if (time === null || time < 0 || time > horizon) continue;
    best = Math.min(best, time);
  }
  return best;
}

/** True if a falling hazard occupies this lane within the horizon. */
function laneHasDrop(
  state: DodgrState,
  drone: DroneState,
  lane: number,
  horizon: number,
): boolean {
  for (const o of state.obstacles) {
    if (o.kind !== 'drop' && !(o.vy < 0)) continue;
    const time = timeToMeet(o, drone);
    if (time === null || time < 0 || time > horizon) continue;
    if (occupancyMask(o, time) & (1 << lane)) return true;
  }
  return false;
}

/** Soonest meet time of a non-waitable threat occupying `lane`, or Infinity. */
function laneThreatTime(
  state: DodgrState,
  drone: DroneState,
  lane: number,
  horizon: number,
): number {
  let best = Infinity;
  for (const o of state.obstacles) {
    const time = timeToMeet(o, drone);
    if (time === null || time < 0 || time > horizon) continue;
    if (isWaitableBranch(o, drone)) continue;
    if (occupancyMask(o, time) & (1 << lane)) {
      best = Math.min(best, time);
    }
  }
  return best;
}

function laneHasThreat(
  state: DodgrState,
  drone: DroneState,
  lane: number,
  horizon: number,
): boolean {
  return laneThreatTime(state, drone, lane, horizon) < Infinity;
}

/**
 * Lowest underside-minus-margin of obstacles sitting over `x`, or Infinity.
 */
function overheadCeiling(
  state: DodgrState,
  drone: DroneState,
  x: number,
): number {
  let cap = Number.POSITIVE_INFINITY;
  for (const o of state.obstacles) {
    if (o.kind !== 'branch') continue;
    if (Math.abs(o.x - x) >= o.halfWidth + DODGR_DRONE_HALF_W) continue;
    if (o.y + o.halfHeight < drone.y - DODGR_DRONE_HALF_H) continue;
    const underside = o.y - o.halfHeight;
    if (underside < drone.y - DODGR_DRONE_HALF_H) continue;
    const next = underside - DODGR_DRONE_HALF_H - DODGR_HOLD_UNDER_MARGIN;
    if (next < cap) cap = next;
  }
  return cap;
}

function coveringBranch(state: DodgrState, drone: DroneState): Obstacle | null {
  let best: Obstacle | null = null;
  for (const o of state.obstacles) {
    if (o.kind !== 'branch') continue;
    if (Math.abs(o.x - drone.x) >= o.halfWidth + DODGR_DRONE_HALF_W) continue;
    const underside = o.y - o.halfHeight;
    if (underside < drone.y - DODGR_DRONE_HALF_H) continue;
    if (best === null || o.y < best.y) best = o;
  }
  return best;
}

function belowBranch(drone: DroneState, o: Obstacle): boolean {
  return (
    drone.y + DODGR_DRONE_HALF_H + DODGR_HOLD_UNDER_MARGIN <
    o.y - o.halfHeight
  );
}

function branchPocketMid(o: Obstacle, x: number): number {
  const underside = o.y - o.halfHeight;
  const top = underside - DODGR_DRONE_HALF_H - DODGR_HOLD_UNDER_MARGIN;
  const floor = groundLevelAt(x) + DODGR_DRONE_HALF_H + 0.2;
  const bottom = Math.max(floor, top - 2 * DODGR_HOLD_UNDER_MID);
  if (top <= floor) return floor;
  return (top + bottom) / 2;
}

function dropClearOfBranch(o: Obstacle): number {
  return o.y - o.halfHeight - DODGR_DRONE_HALF_H - DODGR_HOLD_UNDER_MARGIN;
}

function soonestThreatTime(
  state: DodgrState,
  drone: DroneState,
  horizon: number,
): number {
  let best = Infinity;
  for (const o of state.obstacles) {
    const time = timeToMeet(o, drone);
    if (time === null || time < 0 || time > horizon) continue;
    if (isWaitableBranch(o, drone)) continue;
    best = Math.min(best, time);
  }
  return best;
}

function sidestepTime(
  o: Obstacle,
  drone: DroneState,
  params: PhysicsParams,
  time: number,
): number {
  const aLat = maxLateralAccel(drone, params);
  const mask = occupancyMask(o, time);
  let best = Infinity;
  for (let i = 0; i < DODGR_LANE_COUNT; i += 1) {
    if (mask & (1 << i)) continue;
    best = Math.min(best, strafeTime(drone.x, drone.vx, laneCentre(i), aLat));
  }
  return best;
}

/**
 * Climb-over a co-altitude crosser when a strafe cannot beat time-to-meet.
 * Duck (lower thrust) only if climb is blocked or would not clear in time.
 */
function planVerticalDodge(
  state: DodgrState,
  drone: DroneState,
  params: PhysicsParams,
  horizon: number,
): number | null {
  let chosen: Obstacle | null = null;
  let chosenT = Infinity;

  for (const o of state.obstacles) {
    if (Math.abs(o.vx) <= 0.1) continue;
    const ySep =
      Math.abs(o.y - drone.y) - o.halfHeight - DODGR_DRONE_HALF_H;
    if (ySep > 1.2) continue;
    const tLat = timeToLateralMeet(o, drone);
    if (tLat < 0 || tLat > horizon) continue;
    const tSide = sidestepTime(o, drone, params, tLat);
    if (tSide <= tLat + 0.2) continue;
    if (tLat < chosenT) {
      chosenT = tLat;
      chosen = o;
    }
  }
  if (chosen === null) return null;

  const margin = DODGR_VERT_DODGE_MARGIN;
  const climbY =
    chosen.y + chosen.halfHeight + DODGR_DRONE_HALF_H + margin;
  const duckY = Math.max(
    groundLevelAt(drone.x) + DODGR_DRONE_HALF_H + 0.2,
    chosen.y - chosen.halfHeight - DODGR_DRONE_HALF_H - margin,
  );
  const ceiling = overheadCeiling(state, drone, drone.x);
  const tClimb =
    Math.max(0, climbY - drone.y) / Math.max(MAX_CLIMB_RATE, 0.4) + 0.25;
  const tDuck =
    Math.max(0, drone.y - duckY) / Math.max(MAX_DESCENT_RATE, 0.3) + 0.25;
  const climbOk = climbY <= ceiling + 0.05 && tClimb < chosenT * 1.35;
  const duckOk = duckY < drone.y - 0.08 && tDuck < chosenT * 1.15;

  if (climbOk) return climbY;
  if (duckOk) return duckY;
  if (climbY <= ceiling) return climbY;
  return duckY < drone.y ? duckY : null;
}

/**
 * Pick the safest lane given mass/thrust/tilt reachability. Wait-under
 * branches are cheap on the current lane so a passing drop does not yank
 * the drone out into the fall. Commitment (not a stick bonus) holds the pick.
 */
export function pickSafeLane(
  state: DodgrState,
  drone: DroneState,
  params: PhysicsParams,
): number {
  const cur = laneAt(drone.x);
  if (state.obstacles.length === 0) return cur;

  const aLat = maxLateralAccel(drone, params);
  const horizon = lookAheadHorizon(drone, params);
  const scores = new Array<number>(DODGR_LANE_COUNT).fill(0);
  const soonest = new Array<number>(DODGR_LANE_COUNT).fill(Infinity);

  for (const o of state.obstacles) {
    const time = timeToMeet(o, drone);
    if (time === null || time < 0 || time > horizon) continue;
    const mask = occupancyMask(o, time);
    const waitable = isWaitableBranch(o, drone);
    const base = threatWeight(o, time);

    for (let i = 0; i < DODGR_LANE_COUNT; i += 1) {
      if (!(mask & (1 << i))) continue;
      const weight = waitable && i === cur ? base * 0.12 : base;
      scores[i] += weight;
      if (!waitable || i !== cur) {
        soonest[i] = Math.min(soonest[i], time);
      }
    }
  }

  let best = cur;
  let bestScore = scores[cur];
  for (let i = 0; i < DODGR_LANE_COUNT; i += 1) {
    const tGo = strafeTime(drone.x, drone.vx, laneCentre(i), aLat);
    let extra = 0;
    if (i !== cur && tGo > soonest[cur]) {
      extra += (tGo - soonest[cur]) * 1.1;
    }
    if (i !== cur && soonest[i] < tGo) {
      extra += (tGo - soonest[i]) * 0.85;
    }
    const skip = Math.abs(i - cur) === 2;
    if (skip) {
      const midHot = scores[1] > scores[i] * 0.85;
      extra += midHot ? 0.12 : 0.55;
    }
    const total = scores[i] + extra;
    if (total < bestScore) {
      bestScore = total;
      best = i;
    }
  }
  return best;
}

function resolveDodgeMode(
  state: DodgrState,
  drone: DroneState,
  targetX: number,
  horizon: number,
  parkedUnder: boolean,
): { mode: DodgrDodgeMode; holdCeiling: number } {
  const holdCeiling = overheadCeiling(state, drone, drone.x);
  const dropT = soonestDropTime(state, drone, horizon);
  const dropImminent = dropT < 2.4;
  const imminent =
    dropImminent ||
    soonestThreatTime(state, drone, Math.min(horizon, DODGR_HARD_THREAT_TIME)) <
      Infinity;
  // Leave sooner for drops — even a small lateral error needs full tilt.
  const needX =
    Math.abs(targetX - drone.x) >
    (dropImminent ? 0.35 : DODGR_HARD_ALIGN * 0.65);

  if (parkedUnder) {
    return { mode: 'holdUnder', holdCeiling };
  }
  if (imminent && needX) {
    return { mode: 'hardDodge', holdCeiling };
  }
  return { mode: 'cruise', holdCeiling };
}

/**
 * Choose target lane, stick-until-clear commitment, and survival mode.
 * Call after the world has stepped and before dodgrControl.
 */
export function updateDodgrPlan(
  state: DodgrState,
  drone: DroneState,
  params: PhysicsParams,
): void {
  if (!state.active) return;

  const horizon = lookAheadHorizon(drone, params);
  const cur = laneAt(drone.x);
  const picked = pickSafeLane(state, drone, params);

  if (state.committedLane !== null) {
    const committed = state.committedLane;
    const arrived =
      Math.abs(drone.x - laneCentre(committed)) <= DODGR_COMMIT_ARRIVE;
    const blocked =
      laneHasThreat(state, drone, committed, horizon) ||
      laneHasDrop(state, drone, committed, horizon);
    // Two-lane jump through a falling hazard in the middle corridor.
    const pathBlocked =
      !arrived &&
      Math.abs(committed - cur) === 2 &&
      laneHasDrop(state, drone, 1, horizon);
    const stillForced =
      laneThreatTime(state, drone, cur, DODGR_COMMIT_CLEAR_TIME) < Infinity ||
      laneHasDrop(state, drone, cur, horizon) ||
      (!arrived && laneHasThreat(state, drone, cur, horizon));

    if (blocked || pathBlocked) {
      state.committedLane = picked;
      state.targetLane = picked;
    } else if (arrived && !stillForced) {
      state.committedLane = null;
      state.targetLane = picked;
    } else {
      state.targetLane = committed;
    }
  } else {
    const leaving =
      picked !== cur &&
      (laneHasThreat(state, drone, cur, horizon) ||
        laneHasDrop(state, drone, cur, Math.max(horizon, 3)));
    if (leaving) state.committedLane = picked;
    state.targetLane = picked;
  }

  const branch = coveringBranch(state, drone);
  const underLogX =
    branch !== null &&
    Math.abs(branch.x - drone.x) < branch.halfWidth + DODGR_DRONE_HALF_W;
  let holdTargetX = laneCentre(state.targetLane);
  let dodgeAltitude = params.targetAltitude;
  let parkedUnder = false;

  if (branch && underLogX && !belowBranch(drone, branch)) {
    parkedUnder = true;
    holdTargetX = branch.x;
    const leaving =
      state.targetLane !== cur ||
      (state.committedLane !== null && state.committedLane !== cur);
    dodgeAltitude = leaving
      ? dropClearOfBranch(branch)
      : branchPocketMid(branch, drone.x);
    if (leaving && state.committedLane === null) {
      state.committedLane = picked;
    }
    state.targetLane = cur;
  } else {
    const vert = planVerticalDodge(state, drone, params, horizon);
    if (vert !== null) dodgeAltitude = vert;
    if (branch && underLogX) {
      dodgeAltitude = Math.min(dodgeAltitude, dropClearOfBranch(branch));
    } else {
      const cap = overheadCeiling(state, drone, drone.x);
      if (cap < dodgeAltitude) dodgeAltitude = cap;
    }
  }

  const resolved = resolveDodgeMode(
    state,
    drone,
    holdTargetX,
    horizon,
    parkedUnder,
  );
  state.dodgeMode = resolved.mode;
  state.holdCeiling = resolved.holdCeiling;
  state.holdTargetX = holdTargetX;
  state.dodgeAltitude = dodgeAltitude;
}

export function dodgrHit(state: DodgrState, drone: DroneState): boolean {
  if (!state.active) return false;
  for (const o of state.obstacles) {
    if (collides(drone, o)) return true;
  }
  return false;
}

export interface StepDodgrResult {
  hit: boolean;
}

/**
 * Advance obstacles, run the spawn timer, and drive weather.
 * Lane planning and collision run separately so control can react first.
 */
export function stepDodgr(
  state: DodgrState,
  drone: DroneState,
  params: PhysicsParams,
  setParam: (key: ParamKey, value: number) => void,
  dt: number,
): StepDodgrResult {
  if (!state.active) return { hit: false };
  state.runElapsed += dt;
  if (drone.y > state.peakAltitude) state.peakAltitude = drone.y;

  // WIN latches when we touch the target altitude. Never latches while still
  // sitting on the pad on the very first frame.
  if (!state.won && drone.y >= params.targetAltitude - 0.15 && drone.y > 1) {
    state.won = true;
    state.winAltitude = drone.y;
  }
  // WIN clears when the pilot raises the target above where we are now.
  if (state.won && params.targetAltitude > drone.y + 0.75) {
    state.won = false;
    state.winAltitude = 0;
  }

  const top = viewTop(drone.y);
  const bottom = viewBottom(drone.y);

  // Motion + cull.
  for (let i = state.obstacles.length - 1; i >= 0; i -= 1) {
    const o = state.obstacles[i];
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    if (o.vx !== 0 || o.vy !== 0) o.lanes = computeLaneMask(o.x, o.halfWidth);

    let cull = false;
    if (o.ttl !== null) {
      o.ttl -= dt;
      if (o.ttl <= 0) cull = true;
    }
    if (o.y + o.halfHeight < bottom - 2) cull = true;
    if (o.y - o.halfHeight > top + 22) cull = true;
    if (Math.abs(o.x) > WORLD.halfWidth + 4) cull = true;

    if (cull) state.obstacles.splice(i, 1);
  }

  // Spawner.
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0) {
    const d = difficulty(drone.y);
    const spawn = rollObstacle(state, drone, d);
    if (spawn) state.obstacles.push(spawn);
    // Retry sooner if we skipped a spawn for fairness.
    state.spawnTimer = spawn ? spawnInterval(d) : 0.35;
  }

  // Weather.
  driveWeather(state, drone, params, setParam, dt);

  return { hit: dodgrHit(state, drone) };
}
