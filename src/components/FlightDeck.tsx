import { MAX_TILT } from '../sim/constants.ts';
import type { Telemetry } from '../sim/types.ts';

type AxisName = 'throttle' | 'roll';

interface FlightDeckProps {
  telemetry: Telemetry;
  onThrottle: (value: number) => void;
  onRoll: (value: number) => void;
  onAxisActive: (axis: AxisName, active: boolean) => void;
  onToggleCruise: () => void;
  onToggleFailsafe: () => void;
  onToggleBattery: () => void;
  onToggleDodgr: () => void;
  onKill: () => void;
  onReset: () => void;
}

const THROTTLE_TICKS = [100, 75, 50, 25, 0];

export function FlightDeck({
  telemetry,
  onThrottle,
  onRoll,
  onAxisActive,
  onToggleCruise,
  onToggleFailsafe,
  onToggleBattery,
  onToggleDodgr,
  onKill,
  onReset,
}: FlightDeckProps) {
  const locked = telemetry.failsafe || telemetry.killed || telemetry.crashed;
  const throttlePercent = Math.round(telemetry.throttle * 100);
  const rollDegrees = (telemetry.rollCmd * 180) / Math.PI;

  const axisHandlers = (axis: AxisName) => ({
    onPointerDown: () => onAxisActive(axis, true),
    onPointerUp: () => onAxisActive(axis, false),
    onPointerCancel: () => onAxisActive(axis, false),
    onLostPointerCapture: () => onAxisActive(axis, false),
    onBlur: () => onAxisActive(axis, false),
  });

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Flight Deck</h2>
        <span className="panel-tag">pilot inputs</span>
      </header>

      <div className="deck-grid">
        <div className="throttle-block">
          <div className="row-head">
            <label htmlFor="throttle">Thrust</label>
            <span className="row-value">{throttlePercent}%</span>
          </div>
          <div className="throttle-body">
            <div className="throttle-scale" aria-hidden="true">
              {THROTTLE_TICKS.map((tick) => (
                <span key={tick}>{tick}</span>
              ))}
            </div>
            <div className={`throttle-shaft${locked ? ' is-locked' : ''}`}>
              <div className="throttle-fill" style={{ height: `${throttlePercent}%` }} />
              <input
                id="throttle"
                className="v-range"
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={telemetry.throttle}
                disabled={locked}
                onChange={(event) => onThrottle(Number(event.target.value))}
                {...axisHandlers('throttle')}
              />
            </div>
          </div>
          <p className="ctl-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> raw motor power
          </p>
        </div>

        <div className="deck-side">
          <div className="row">
            <div className="row-head">
              <label htmlFor="tilt">Tilt / Roll</label>
              <span className="row-value">{`${rollDegrees >= 0 ? '+' : ''}${rollDegrees.toFixed(1)}°`}</span>
            </div>
            <div className="slider-shell is-centered">
              <div
                className="slider-fill"
                style={{
                  left: `${Math.min(telemetry.rollCmd / MAX_TILT, 0) * 50 + 50}%`,
                  width: `${(Math.abs(telemetry.rollCmd) / MAX_TILT) * 50}%`,
                }}
              />
              <input
                id="tilt"
                type="range"
                min={-MAX_TILT}
                max={MAX_TILT}
                step={0.005}
                value={telemetry.rollCmd}
                disabled={locked}
                onChange={(event) => onRoll(Number(event.target.value))}
                {...axisHandlers('roll')}
              />
            </div>
            <p className="ctl-hint">
              <kbd>←</kbd>
              <kbd>→</kbd> tilt to translate
            </p>
          </div>
        </div>
      </div>

      <div className="actions">
        <button
          type="button"
          className={`action is-cruise${telemetry.cruise ? ' is-armed' : ''}`}
          onClick={onToggleCruise}
          disabled={telemetry.killed || telemetry.crashed}
        >
          <span className="action-label">Autopilot</span>
          <span className="action-state">
            {telemetry.cruise ? 'engaged' : 'standby'}
          </span>
          <kbd>C</kbd>
        </button>
        <button
          type="button"
          className={`action is-failsafe${telemetry.failsafe ? ' is-armed' : ''}`}
          onClick={onToggleFailsafe}
          disabled={telemetry.killed || telemetry.crashed}
        >
          <span className="action-label">Drop</span>
          <span className="action-state">
            {telemetry.failsafe
              ? telemetry.braking
                ? 'braking'
                : 'falling'
              : 'armed off'}
          </span>
          <kbd>F</kbd>
        </button>
        <button
          type="button"
          className={`action is-battery${telemetry.batteryEnabled ? ' is-armed' : ''}`}
          onClick={onToggleBattery}
        >
          <span className="action-label">Battery</span>
          <span className="action-state">
            {telemetry.batteryEnabled
              ? telemetry.batteryBrownout
                ? 'brown-out'
                : telemetry.batteryInReserve
                  ? 'reserve'
                  : 'tracking'
              : 'module off'}
          </span>
          <kbd>B</kbd>
        </button>
        <button
          type="button"
          className={`action is-kill${telemetry.killed ? ' is-armed' : ''}`}
          onClick={onKill}
          disabled={telemetry.killed || telemetry.crashed}
        >
          <span className="action-label">Kill</span>
          <span className="action-state">
            {telemetry.killed ? 'power cut' : 'live'}
          </span>
          <kbd>K</kbd>
        </button>
        <button type="button" className="action is-reset" onClick={onReset}>
          <span className="action-label">Reset</span>
          <span className="action-state">back to pad</span>
          <kbd>R</kbd>
        </button>
      </div>

      <button
        type="button"
        className={`action is-dodgr${telemetry.dodgr ? ' is-armed' : ''}`}
        onClick={onToggleDodgr}
        disabled={telemetry.killed || telemetry.crashed}
      >
        <span className="action-label">
          {telemetry.dodgr ? 'Deactivate DODGR' : 'Activate DODGR'}
        </span>
        <span className="action-state">
          {telemetry.dodgr
            ? telemetry.dodgrWon
              ? 'target reached'
              : 'dodging obstacles'
            : 'mini-game standby'}
        </span>
        <kbd>D</kbd>
      </button>
    </section>
  );
}
