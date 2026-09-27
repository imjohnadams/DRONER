import { EnvironmentalPanel } from './components/EnvironmentalPanel.tsx';
import { FlightDeck } from './components/FlightDeck.tsx';
import { Hud, ModeChip } from './components/Hud.tsx';
import { PhysicsPanel } from './components/PhysicsPanel.tsx';
import { StatsPanel } from './components/StatsPanel.tsx';
import { WarehouseView } from './components/WarehouseView.tsx';
import { useSimulation } from './hooks/useSimulation.ts';
import { SOFT_CEILING, VIEW_HEIGHT } from './sim/constants.ts';

export default function App() {
  const sim = useSimulation();

  return (
    <div className="cockpit">
      <header className="cockpit-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">DRONER</span>
          <span className="brand-sub">quadcopter flight simulator</span>
        </div>
        <ModeChip mode={sim.telemetry.mode} />
      </header>

      <main className="cockpit-body">
        <aside className="rail rail-left">
          <EnvironmentalPanel params={sim.params} onParamChange={sim.setParam} />
          <StatsPanel telemetry={sim.telemetry} />
        </aside>

        <section className="viewport">
          <WarehouseView
            droneRef={sim.droneRef}
            paramsRef={sim.paramsRef}
            tabsRef={sim.tabsRef}
            dodgrRef={sim.dodgrRef}
          />
          <Hud telemetry={sim.telemetry} targetAltitude={sim.params.targetAltitude} />
          <footer className="viewport-legend">
            <span>bay 04 · open test shaft</span>
            <span>
              {`${VIEW_HEIGHT} m window · soft cap ${SOFT_CEILING / 1000} km`}
            </span>
          </footer>
        </section>

        <aside className="rail rail-right">
          <PhysicsPanel
            params={sim.params}
            telemetry={sim.telemetry}
            onParamChange={sim.setParam}
          />
          <FlightDeck
            telemetry={sim.telemetry}
            onThrottle={sim.setThrottle}
            onRoll={sim.setRoll}
            onAxisActive={sim.setAxisActive}
            onToggleCruise={sim.toggleCruise}
            onToggleFailsafe={sim.toggleFailsafe}
            onToggleBattery={sim.toggleBattery}
            onToggleDodgr={sim.toggleDodgr}
            onKill={sim.kill}
            onReset={sim.reset}
          />
        </aside>
      </main>
    </div>
  );
}
