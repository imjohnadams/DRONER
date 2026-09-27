import { BATTERY_LOW_USABLE } from '../sim/constants.ts';
import type { FlightMode, Telemetry } from '../sim/types.ts';

interface HudProps {
  telemetry: Telemetry;
  /** Live target-altitude slider value, used to show remaining climb. */
  targetAltitude: number;
}

const MODE_META: Record<FlightMode, { label: string; tone: string }> = {
  standby: { label: 'STANDBY', tone: 'neutral' },
  manual: { label: 'MANUAL', tone: 'live' },
  cruise: { label: 'AUTOPILOT', tone: 'cruise' },
  dodgr: { label: 'DODGR', tone: 'dodgr' },
  failsafe: { label: 'FAIL-SAFE', tone: 'warn' },
  killed: { label: 'KILLED', tone: 'danger' },
  crashed: { label: 'CRASHED', tone: 'danger' },
};

const LANE_LABEL = ['LEFT', 'MID', 'RIGHT'];

/** Status chip for the title bar, kept in sync with the HUD's mode read-out. */
export function ModeChip({ mode }: { mode: FlightMode }) {
  const meta = MODE_META[mode];
  return (
    <div className={`mode-chip tone-${meta.tone}`}>
      <span className="mode-dot" aria-hidden="true" />
      {meta.label}
    </div>
  );
}

export function Hud({ telemetry, targetAltitude }: HudProps) {
  const mode = MODE_META[telemetry.mode];
  const alerts: { key: string; tone: string; text: string }[] = [];

  if (telemetry.braking) {
    alerts.push({ key: 'brake', tone: 'warn', text: 'BRAKING BURN ACTIVE' });
  }
  if (telemetry.batteryEnabled && telemetry.batteryBrownout) {
    alerts.push({ key: 'batt-empty', tone: 'danger', text: 'BATTERY EMPTY · RESERVE LOCKED' });
  } else if (telemetry.batteryEnabled && telemetry.batteryInReserve) {
    alerts.push({ key: 'batt-res', tone: 'warn', text: 'RESERVE' });
  } else if (
    telemetry.batteryEnabled &&
    telemetry.batteryUsableSoc > 0 &&
    telemetry.batteryUsableSoc < BATTERY_LOW_USABLE
  ) {
    alerts.push({ key: 'batt-low', tone: 'warn', text: 'LOW BATTERY' });
  }
  if (!telemetry.canHover && !telemetry.crashed) {
    alerts.push({ key: 'lift', tone: 'danger', text: 'THRUST BELOW WEIGHT' });
  }
  if (telemetry.crashed) {
    alerts.push({
      key: 'impact',
      tone: 'danger',
      text: `IMPACT ${telemetry.impactSpeed.toFixed(1)} M/S`,
    });
  }

  const showDodgrRow = telemetry.dodgr;
  const climbRemaining = targetAltitude - telemetry.altitude;
  const laneLabel =
    telemetry.dodgrTargetLane >= 0 && telemetry.dodgrTargetLane < LANE_LABEL.length
      ? LANE_LABEL[telemetry.dodgrTargetLane]
      : '—';

  return (
    <div className="hud">
      <div className="hud-readouts">
        <div className="hud-cell">
          <span className="hud-key">ALT</span>
          <span className="hud-value">{telemetry.altitude.toFixed(2)}</span>
          <span className="hud-unit">m</span>
        </div>
        <div className="hud-cell">
          <span className="hud-key">THR</span>
          <span className="hud-value">{Math.round(telemetry.throttle * 100)}</span>
          <span className="hud-unit">%</span>
        </div>
        <div className="hud-cell">
          <span className="hud-key">MODE</span>
          <span className={`hud-value hud-mode tone-${mode.tone}`}>{mode.label}</span>
        </div>
      </div>
      {showDodgrRow && (
        <div className="hud-dodgr">
          {telemetry.dodgrWon ? (
            <span className="hud-win">
              WIN · target {targetAltitude.toFixed(1)} m reached · raise to keep climbing
            </span>
          ) : (
            <span className="hud-dodgr-line">
              TARGET {targetAltitude.toFixed(1)} m
              <span className="hud-dodgr-sep">·</span>
              {climbRemaining > 0
                ? `${climbRemaining.toFixed(1)} m to go`
                : 'at altitude'}
              <span className="hud-dodgr-sep">·</span>
              LANE {laneLabel}
              <span className="hud-dodgr-sep">·</span>
              PEAK {telemetry.dodgrPeakAltitude.toFixed(1)} m
            </span>
          )}
        </div>
      )}
      {alerts.length > 0 && (
        <div className="hud-alerts">
          {alerts.map((alert) => (
            <span key={alert.key} className={`hud-alert tone-${alert.tone}`}>
              {alert.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
