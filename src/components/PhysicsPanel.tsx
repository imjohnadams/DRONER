import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PARAMS, SOFT_CEILING } from '../sim/constants.ts';
import type { ParamKey, PhysicsParams, Telemetry } from '../sim/types.ts';

/** Params that get the recentering slider treatment. */
type TunedKey = 'gravity' | 'mass' | 'maxMotorThrust' | 'targetAltitude';

/** Notches between 0 and the current top of a slider. */
const SLIDER_STEPS = 20;
/** Top of the range when the pilot commits a 0 and there is nothing to double. */
const EMPTY_RANGE_MAX = 1;

interface PhysicsPanelProps {
  params: PhysicsParams;
  telemetry: Telemetry;
  onParamChange: (key: ParamKey, value: number) => void;
}

interface TunedRowProps {
  paramKey: TunedKey;
  label: string;
  unit: string;
  decimals: number;
  value: number;
  max: number;
  note: string;
  onSlide: (key: TunedKey, value: number) => void;
  onCommit: (key: TunedKey, raw: string) => number;
}

/** Trim trailing zeros so range hints read as 0.12 rather than 0.120. */
function compact(value: number): string {
  return String(Number(value.toFixed(3)));
}

function TunedRow({
  paramKey,
  label,
  unit,
  decimals,
  value,
  max,
  note,
  onSlide,
  onCommit,
}: TunedRowProps) {
  const [draft, setDraft] = useState(() => value.toFixed(decimals));
  const editing = useRef(false);

  // Dragging the slider has to write back into the box, but not mid-keystroke.
  useEffect(() => {
    if (!editing.current) setDraft(value.toFixed(decimals));
  }, [value, decimals]);

  const commit = () => {
    editing.current = false;
    setDraft(onCommit(paramKey, draft).toFixed(decimals));
  };

  const step = max / SLIDER_STEPS;
  const fraction = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;

  return (
    <div className="row">
      <div className="row-head">
        <label htmlFor={`param-${paramKey}`}>{label}</label>
        <span className="row-value">{note}</span>
      </div>
      <div className="tuner">
        <div className="slider-shell">
          <div className="slider-fill" style={{ left: 0, width: `${fraction * 100}%` }} />
          <input
            id={`param-${paramKey}`}
            type="range"
            min={0}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onSlide(paramKey, Number(event.target.value))}
          />
        </div>
        <div className="numeric-shell is-compact">
          <input
            type="text"
            inputMode="decimal"
            aria-label={`${label} value`}
            value={draft}
            onFocus={() => {
              editing.current = true;
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <span className="numeric-unit">{unit}</span>
        </div>
      </div>
      <p className="row-hint">{`0 – ${compact(max)} ${unit} · step ${compact(step)}`}</p>
    </div>
  );
}

export function PhysicsPanel({ params, telemetry, onParamChange }: PhysicsPanelProps) {
  // Slider ranges live here, not in the sim: typing a value recentres the
  // control around it while the sim only ever sees the value itself.
  const [maxima, setMaxima] = useState<Record<TunedKey, number>>(() => ({
    gravity: DEFAULT_PARAMS.gravity * 2,
    mass: DEFAULT_PARAMS.mass * 2,
    maxMotorThrust: DEFAULT_PARAMS.maxMotorThrust * 2,
    targetAltitude: DEFAULT_PARAMS.targetAltitude * 2,
  }));

  const hardMax = (key: TunedKey) =>
    key === 'targetAltitude' ? SOFT_CEILING : Number.POSITIVE_INFINITY;

  const slide = (key: TunedKey, value: number) => onParamChange(key, value);

  const commit = (key: TunedKey, raw: string): number => {
    const parsed = Number.parseFloat(raw);
    const wanted = Number.isFinite(parsed) ? parsed : params[key];
    const committed = Math.min(Math.max(wanted, 0), hardMax(key));

    onParamChange(key, committed);
    setMaxima((previous) => ({
      ...previous,
      [key]:
        committed > 0
          ? Math.min(committed * 2, hardMax(key))
          : previous[key] || EMPTY_RANGE_MAX,
    }));
    return committed;
  };

  const ratio = telemetry.thrustToWeight;
  const ratioLabel = Number.isFinite(ratio) ? `${ratio.toFixed(2)}:1` : 'no weight';
  const altitudeError = params.targetAltitude - telemetry.altitude;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Physics Sliders</h2>
        <span className="panel-tag">world laws</span>
      </header>

      <TunedRow
        paramKey="gravity"
        label="Gravity"
        unit="m/s²"
        decimals={2}
        value={params.gravity}
        max={maxima.gravity}
        note={`${params.gravity.toFixed(2)} m/s²`}
        onSlide={slide}
        onCommit={commit}
      />
      <TunedRow
        paramKey="mass"
        label="Drone Mass"
        unit="kg"
        decimals={2}
        value={params.mass}
        max={maxima.mass}
        note={`${(params.mass * params.gravity).toFixed(1)} N weight`}
        onSlide={slide}
        onCommit={commit}
      />
      <TunedRow
        paramKey="maxMotorThrust"
        label="Max Motor Thrust"
        unit="N"
        decimals={1}
        value={params.maxMotorThrust}
        max={maxima.maxMotorThrust}
        note={`${ratioLabel}${telemetry.canHover ? '' : ' · cannot hover'}`}
        onSlide={slide}
        onCommit={commit}
      />
      <TunedRow
        paramKey="targetAltitude"
        label="Target Cruising Altitude"
        unit="m"
        decimals={1}
        value={params.targetAltitude}
        max={maxima.targetAltitude}
        note={`err ${altitudeError >= 0 ? '+' : ''}${altitudeError.toFixed(2)} m`}
        onSlide={slide}
        onCommit={commit}
      />
    </section>
  );
}
