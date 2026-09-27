import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  DT,
  KEY_ROLL_RATE,
  KEY_THROTTLE_RATE,
  MAX_SUBSTEPS,
  MAX_TILT,
  DEFAULT_PARAMS,
} from '../sim/constants.ts';
import { isaDensity, isaPressure } from '../sim/atmosphere.ts';
import { cruiseControl, dodgrControl } from '../sim/autopilot.ts';
import {
  batteryBrownout,
  batteryInReserve,
  batterySoc,
  effectiveMaxThrust,
  remainingSeconds,
  usableSoc,
} from '../sim/battery.ts';
import {
  clearDodgr,
  createDodgrState,
  dodgrHit,
  noteManualParam,
  stepDodgr,
  updateDodgrPlan,
} from '../sim/dodgr.ts';
import type { DodgrState } from '../sim/dodgr.ts';
import { failsafeControl } from '../sim/failsafe.ts';
import {
  approach,
  clamp,
  createDroneState,
  resetDroneState,
  stepPhysics,
} from '../sim/physics.ts';
import { paramBounds, windLimit } from '../sim/weather.ts';
import type {
  ChangeTab,
  DroneState,
  FlightMode,
  ParamKey,
  PhysicsParams,
  PilotInput,
  TabKind,
  Telemetry,
} from '../sim/types.ts';

type AxisName = 'throttle' | 'roll';

const KEY_AXIS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const PARAM_TABS: Record<ParamKey, { kind: TabKind; label: (v: number) => string }> = {
  gravity: { kind: 'gravity', label: (v) => `GRAVITY ${v.toFixed(2)} M/S²` },
  mass: { kind: 'mass', label: (v) => `MASS ${v.toFixed(2)} KG` },
  maxMotorThrust: { kind: 'thrust', label: (v) => `MAX THRUST ${v.toFixed(0)} N` },
  wind: {
    kind: 'wind',
    label: (v) =>
      Math.abs(v) < 0.05
        ? 'WIND CALM'
        : `WIND ${Math.abs(v).toFixed(1)} M/S ${v < 0 ? 'LEFT' : 'RIGHT'}`,
  },
  rain: { kind: 'rain', label: (v) => `RAIN ${Math.round(v * 100)}%` },
  turbulence: {
    kind: 'turbulence',
    label: (v) => `TURBULENCE ${Math.round(v * 100)}%`,
  },
  targetAltitude: { kind: 'altitude', label: (v) => `TARGET ${v.toFixed(1)} M` },
};

function deriveMode(drone: DroneState): FlightMode {
  if (drone.crashed) return 'crashed';
  if (drone.killed) return 'killed';
  if (drone.failsafe) return 'failsafe';
  // DODGR wins the chip whenever it is arming a live airframe, even when the
  // pilot has turned autopilot off, so the console reads honestly.
  if (drone.dodgr) return 'dodgr';
  if (drone.cruise) return 'cruise';
  if (drone.landed && drone.throttle < 0.005) return 'standby';
  return 'manual';
}

function snapshot(
  drone: DroneState,
  params: PhysicsParams,
  dodgr: DodgrState,
): Telemetry {
  const weight = params.mass * params.gravity;
  const peak = effectiveMaxThrust(drone, params);
  const density = isaDensity(drone.y);
  return {
    altitude: drone.y,
    verticalSpeed: drone.vy,
    lateralSpeed: drone.vx,
    lateralAccel: drone.ax,
    verticalAccel: drone.ay,
    roll: drone.roll,
    rollCmd: drone.rollCmd,
    throttle: drone.throttle,
    thrust: drone.thrust,
    mode: deriveMode(drone),
    cruise: drone.cruise,
    failsafe: drone.failsafe,
    killed: drone.killed,
    crashed: drone.crashed,
    landed: drone.landed,
    braking: drone.braking,
    impactSpeed: drone.impactSpeed,
    thrustToWeight: weight > 0 ? peak / weight : Infinity,
    canHover: peak >= weight,
    dodgr: drone.dodgr,
    dodgrWon: drone.dodgrWon,
    lateralPosition: drone.x,
    dodgrTargetLane: dodgr.active ? dodgr.targetLane : -1,
    dodgrPeakAltitude: dodgr.peakAltitude,
    airPressure: isaPressure(drone.y),
    airDensity: density,
    batteryEnabled: drone.batteryEnabled,
    batterySoc: batterySoc(drone),
    batteryUsableSoc: usableSoc(drone),
    batteryInReserve: batteryInReserve(drone),
    batteryBrownout: batteryBrownout(drone),
    batterySeconds: remainingSeconds(drone, drone.thrust, density),
  };
}

export interface SimulationApi {
  telemetry: Telemetry;
  params: PhysicsParams;
  droneRef: RefObject<DroneState>;
  paramsRef: RefObject<PhysicsParams>;
  tabsRef: RefObject<Map<TabKind, ChangeTab>>;
  dodgrRef: RefObject<DodgrState>;
  setParam: (key: ParamKey, value: number) => void;
  setThrottle: (value: number) => void;
  setRoll: (value: number) => void;
  setAxisActive: (axis: AxisName, active: boolean) => void;
  toggleCruise: () => void;
  toggleFailsafe: () => void;
  toggleBattery: () => void;
  toggleDodgr: () => void;
  kill: () => void;
  reset: () => void;
}

export function useSimulation(): SimulationApi {
  const droneRef = useRef<DroneState>(createDroneState());
  const paramsRef = useRef<PhysicsParams>({ ...DEFAULT_PARAMS });
  const tabsRef = useRef<Map<TabKind, ChangeTab>>(new Map());
  const dodgrRef = useRef<DodgrState>(createDodgrState());
  const keysRef = useRef({ up: false, down: false, left: false, right: false });
  const pointerRef = useRef({ throttle: false, roll: false });
  const inputRef = useRef<PilotInput>({ throttleActive: false, rollActive: false });

  const [params, setParams] = useState<PhysicsParams>(() => ({ ...DEFAULT_PARAMS }));
  const [telemetry, setTelemetry] = useState<Telemetry>(() =>
    snapshot(createDroneState(), DEFAULT_PARAMS, dodgrRef.current),
  );

  const raiseTab = useCallback((kind: TabKind, label: string, direction: number) => {
    tabsRef.current.set(kind, {
      kind,
      label,
      direction,
      born: performance.now() / 1000,
    });
  }, []);

  /** True while the pilot still has authority over the motors. */
  const pilotHasControl = useCallback(() => {
    const drone = droneRef.current;
    return !drone.killed && !drone.crashed && !drone.failsafe;
  }, []);

  const applyThrottle = useCallback(
    (value: number) => {
      const drone = droneRef.current;
      const next = clamp(value, 0, 1);
      if (next > drone.throttle + 0.015) {
        raiseTab('thrust', `THRUST ${Math.round(next * 100)}%`, 1);
      }
      drone.throttle = next;
    },
    [raiseTab],
  );

  /**
   * Core writer: bounds-check, snapshot, and raise a change tab. Used both by
   * the sliders (via setParam) and by the DODGR loop (via driveParam), so the
   * environmental panel and canvas tabs update the same way either way.
   */
  const writeParam = useCallback(
    (key: ParamKey, value: number) => {
      const current = paramsRef.current;
      const bounds = paramBounds(key, current);
      const next = clamp(Number.isFinite(value) ? value : current[key], bounds.min, bounds.max);
      const previous = current[key];
      if (next === previous) return;

      const updated: PhysicsParams = { ...current, [key]: next };
      // Weaker motors cannot fight the wind they could a moment ago.
      if (key === 'maxMotorThrust') {
        const limit = windLimit(updated);
        updated.wind = clamp(updated.wind, -limit, limit);
      }
      paramsRef.current = updated;
      setParams(updated);

      const tab = PARAM_TABS[key];
      raiseTab(tab.kind, tab.label(next), Math.sign(next - previous));
    },
    [raiseTab],
  );

  /** Slider path: any pilot edit latches DODGR off that weather key. */
  const setParam = useCallback(
    (key: ParamKey, value: number) => {
      noteManualParam(dodgrRef.current, key);
      writeParam(key, value);
    },
    [writeParam],
  );

  const setThrottle = useCallback(
    (value: number) => {
      if (!pilotHasControl()) return;
      applyThrottle(value);
    },
    [applyThrottle, pilotHasControl],
  );

  const setRoll = useCallback(
    (value: number) => {
      if (!pilotHasControl()) return;
      droneRef.current.rollCmd = clamp(value, -MAX_TILT, MAX_TILT);
    },
    [pilotHasControl],
  );

  const setAxisActive = useCallback((axis: AxisName, active: boolean) => {
    pointerRef.current[axis] = active;
  }, []);

  const toggleCruise = useCallback(() => {
    const drone = droneRef.current;
    if (drone.killed || drone.crashed) return;
    if (drone.cruise) {
      drone.cruise = false;
      return;
    }
    drone.cruise = true;
    drone.failsafe = false;
    drone.braking = false;
  }, []);

  /** Arm Drop: cut motors, unlock reserve for the braking burn. */
  const engageFailsafe = useCallback((drone: DroneState) => {
    drone.failsafe = true;
    drone.cruise = false;
    drone.braking = false;
    drone.throttle = 0;
  }, []);

  const toggleFailsafe = useCallback(() => {
    const drone = droneRef.current;
    if (drone.killed || drone.crashed) return;
    if (drone.failsafe) {
      drone.braking = false;
      drone.failsafe = false;
      return;
    }
    engageFailsafe(drone);
  }, [engageFailsafe]);

  const toggleBattery = useCallback(() => {
    const drone = droneRef.current;
    drone.batteryEnabled = !drone.batteryEnabled;
  }, []);

  /**
   * DODGR toggle. Turning it on engages autopilot too (the pilot can still
   * disengage cruise afterwards; DODGR keeps spawning obstacles either way).
   * Turning it off clears obstacles and lets the weather sliders settle.
   */
  const toggleDodgr = useCallback(() => {
    const drone = droneRef.current;
    const dodgr = dodgrRef.current;
    if (drone.killed || drone.crashed) return;

    if (drone.dodgr) {
      drone.dodgr = false;
      drone.dodgrWon = false;
      clearDodgr(dodgr);
      return;
    }

    // Engage cruise as part of activation; drone.dodgr flags the mode chip
    // and lets the loop pick dodgrControl over cruiseControl.
    drone.dodgr = true;
    drone.dodgrWon = false;
    drone.cruise = true;
    drone.failsafe = false;
    drone.braking = false;

    clearDodgr(dodgr);
    dodgr.active = true;
    dodgr.spawnTimer = 0.6;
  }, []);

  const kill = useCallback(() => {
    const drone = droneRef.current;
    if (drone.killed) return;
    drone.killed = true;
    drone.cruise = false;
    drone.failsafe = false;
    drone.braking = false;
    drone.throttle = 0;
    const direction =
      drone.roll !== 0
        ? Math.sign(drone.roll)
        : drone.vx !== 0
          ? Math.sign(drone.vx)
          : 1;
    drone.tumble = direction * (0.7 + Math.abs(drone.vx) * 0.28);
  }, []);

  const reset = useCallback(() => {
    resetDroneState(droneRef.current);
    clearDodgr(dodgrRef.current);
    tabsRef.current.clear();
    keysRef.current.up = false;
    keysRef.current.down = false;
    keysRef.current.left = false;
    keysRef.current.right = false;
  }, []);

  // Keyboard: arrows slew the flight-deck sliders, letters hit the action buttons.
  useEffect(() => {
    const typing = () => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return false;
      const tag = active.tagName;
      if (tag === 'TEXTAREA') return true;
      return tag === 'INPUT' && (active as HTMLInputElement).type !== 'range';
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing()) return;

      const axis = KEY_AXIS[event.key];
      if (axis) {
        event.preventDefault();
        keysRef.current[axis] = true;
        return;
      }

      switch (event.key.toLowerCase()) {
        case 'c':
          event.preventDefault();
          toggleCruise();
          break;
        case 'f':
          event.preventDefault();
          toggleFailsafe();
          break;
        case 'b':
          event.preventDefault();
          toggleBattery();
          break;
        case 'd':
          event.preventDefault();
          toggleDodgr();
          break;
        case 'k':
          event.preventDefault();
          kill();
          break;
        case 'r':
          event.preventDefault();
          reset();
          break;
        default:
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const axis = KEY_AXIS[event.key];
      if (axis) keysRef.current[axis] = false;
    };

    const releaseAll = () => {
      keysRef.current.up = false;
      keysRef.current.down = false;
      keysRef.current.left = false;
      keysRef.current.right = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
    };
  }, [kill, reset, toggleBattery, toggleCruise, toggleDodgr, toggleFailsafe]);

  // Fixed-step sim loop. Authority order: kill > fail-safe > pilot > cruise.
  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    let accumulator = 0;

    const step = (dt: number) => {
      const drone = droneRef.current;
      const currentParams = paramsRef.current;
      const input = inputRef.current;
      const keys = keysRef.current;

      const keyThrottle = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
      const keyRoll = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      input.throttleActive = pointerRef.current.throttle || keyThrottle !== 0;
      input.rollActive = pointerRef.current.roll || keyRoll !== 0;

      const pilotOwnsMotors = !drone.killed && !drone.crashed && !drone.failsafe;
      if (pilotOwnsMotors) {
        if (keyThrottle !== 0) {
          applyThrottle(drone.throttle + keyThrottle * KEY_THROTTLE_RATE * dt);
        }
        if (keyRoll !== 0) {
          drone.rollCmd = clamp(
            drone.rollCmd + keyRoll * KEY_ROLL_RATE * dt,
            -MAX_TILT,
            MAX_TILT,
          );
        } else if (!drone.cruise && !input.rollActive) {
          drone.rollCmd = approach(drone.rollCmd, 0, KEY_ROLL_RATE * dt);
        }
      }

      // Move obstacles and pick the dodge before motors so the same tick
      // can commit and roll instead of spending one frame on a stale lane.
      if (drone.dodgr && !drone.killed && !drone.crashed) {
        stepDodgr(
          dodgrRef.current,
          drone,
          currentParams,
          writeParam,
          dt,
        );
        updateDodgrPlan(dodgrRef.current, drone, currentParams);
        drone.dodgrWon = dodgrRef.current.won;
      }

      if (drone.killed || drone.crashed) {
        drone.throttle = 0;
      } else if (drone.failsafe || batteryBrownout(drone)) {
        // Usable pack empty → auto-arm Drop so the reserve powers the burn.
        if (!drone.failsafe) engageFailsafe(drone);
        const output = failsafeControl(drone, currentParams);
        drone.throttle = output.throttle;
        drone.rollCmd = output.rollCmd;
        drone.braking = output.braking;
      } else if (drone.dodgr && drone.cruise) {
        const dodgr = dodgrRef.current;
        const output = dodgrControl(
          drone,
          currentParams,
          input,
          dodgr.holdTargetX,
          dodgr.dodgeMode,
          dodgr.dodgeAltitude,
        );
        drone.throttle = output.throttle;
        drone.rollCmd = output.rollCmd;
      } else if (drone.cruise) {
        const output = cruiseControl(drone, currentParams, input);
        drone.throttle = output.throttle;
        drone.rollCmd = output.rollCmd;
      }

      if (drone.dodgr && !drone.killed && !drone.crashed) {
        if (dodgrHit(dodgrRef.current, drone)) {
          drone.crashed = true;
          drone.throttle = 0;
          drone.thrust = 0;
          drone.impactSpeed = Math.max(
            Math.abs(drone.vy),
            Math.abs(drone.vx),
            2.6,
          );
          drone.braking = false;
          // Freeze the world so what wrecked us stays on-screen until Reset.
          dodgrRef.current.active = false;
          const direction =
            drone.roll !== 0
              ? Math.sign(drone.roll)
              : drone.vx !== 0
                ? Math.sign(drone.vx)
                : 1;
          drone.tumble = direction * (0.6 + Math.abs(drone.vx) * 0.28);
        }
      }

      stepPhysics(drone, currentParams, dt);
    };

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      accumulator += Math.min((now - previous) / 1000, 0.25);
      previous = now;

      let substeps = 0;
      while (accumulator >= DT && substeps < MAX_SUBSTEPS) {
        step(DT);
        accumulator -= DT;
        substeps += 1;
      }
      if (substeps === MAX_SUBSTEPS) accumulator = 0;

      setTelemetry(
        snapshot(droneRef.current, paramsRef.current, dodgrRef.current),
      );
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [applyThrottle, engageFailsafe, writeParam]);

  return {
    telemetry,
    params,
    droneRef,
    paramsRef,
    tabsRef,
    dodgrRef,
    setParam,
    setThrottle,
    setRoll,
    setAxisActive,
    toggleCruise,
    toggleFailsafe,
    toggleBattery,
    toggleDodgr,
    kill,
    reset,
  };
}
