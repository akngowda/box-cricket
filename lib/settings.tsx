'use client';

/**
 * R0 / R2 — one settings panel, shown three times.
 *
 * General is seeded once and stands alone. Starting a series shows the general
 * values pre-filled; starting a match shows the series values pre-filled. The
 * admin never sees two levels side by side, so this is the same component with
 * a different starting value each time.
 */

import { DEFAULT_RULES } from '../src/engine/rules';
import type { DotCarryMode, RulesConfig, RulesConfigOverride } from '../src/engine/types';
import { NumberPicker, SettingRow, Toggle } from './ui';

export function fill(over: RulesConfigOverride): RulesConfig {
  return { ...DEFAULT_RULES, ...over };
}

export function RulesEditor({
  value,
  onChange,
}: {
  value: RulesConfig;
  onChange: (next: RulesConfig) => void;
}) {
  const set = <K extends keyof RulesConfig>(key: K, v: RulesConfig[K]): void =>
    onChange({ ...value, [key]: v });
  const flip = (key: keyof RulesConfig) => () => set(key, !value[key] as never);

  return (
    <div>
      <SettingRow label="Overs per innings">
        <NumberPicker
          label="Overs per innings"
          value={value.oversPerInnings}
          quick={[4, 5, 6, 8]}
          min={1}
          max={50}
          onChange={(n) => set('oversPerInnings', n)}
        />
      </SettingRow>
      <SettingRow label="Balls per over">
        <NumberPicker
          label="Balls per over"
          value={value.ballsPerOver}
          quick={[4, 5, 6, 8]}
          min={1}
          max={12}
          onChange={(n) => set('ballsPerOver', n)}
        />
      </SettingRow>
      <SettingRow label="Max overs per bowler">
        <NumberPicker
          label="Max overs per bowler"
          value={value.maxOversPerBowler}
          quick={[1, 2, 3, 4]}
          min={1}
          max={50}
          onChange={(n) => set('maxOversPerBowler', n)}
        />
      </SettingRow>
      <SettingRow label="No ball runs">
        <NumberPicker
          label="No ball runs"
          value={value.noBallRuns}
          quick={[0, 1, 2, 3]}
          min={0}
          max={9}
          onChange={(n) => set('noBallRuns', n)}
        />
      </SettingRow>
      <SettingRow label="Wide runs">
        <NumberPicker
          label="Wide runs"
          value={value.wideRuns}
          quick={[0, 1, 2, 3]}
          min={0}
          max={9}
          onChange={(n) => set('wideRuns', n)}
        />
      </SettingRow>

      <SettingRow label="Free hit after no ball">
        <Toggle on={value.freeHitAfterNoBall} onTap={flip('freeHitAfterNoBall')} />
      </SettingRow>
      <SettingRow label="Impact over allowed">
        <Toggle on={value.impactOverAllowed} onTap={flip('impactOverAllowed')} />
      </SettingRow>
      <SettingRow label="Impact ball (last legal ball)">
        <Toggle on={value.impactBallAllowed} onTap={flip('impactBallAllowed')} />
      </SettingRow>
      <SettingRow label="Extras doubled on impact" hint="off by default — extras never double">
        <Toggle on={value.doubleExtrasOnImpact} onTap={flip('doubleExtrasOnImpact')} />
      </SettingRow>

      <div className="card" style={{ padding: '11px 13px', marginBottom: 7 }}>
        <div className="row">
          <div style={{ flex: 1, fontSize: 13 }}>3 consecutive dots = out</div>
          <Toggle on={value.threeDotOut} onTap={flip('threeDotOut')} />
        </div>
        {/* R16b — only meaningful while the 3-dot rule is on. */}
        {value.threeDotOut && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1B2A22' }}>
            <div className="sub" style={{ marginBottom: 7 }}>
              If the striker is on his last dot and the non-striker is run out, his dot streak…
            </div>
            <div className="grid3">
              {(
                [
                  ['reset', 'Reset', 'back to 0'],
                  ['carry', 'Carry', 'next dot out'],
                  ['sudden_death', 'Sudden death', 'any dot out'],
                ] as Array<[DotCarryMode, string, string]>
              ).map(([mode, label, hint]) => (
                <button
                  key={mode}
                  className={`opt ${value.dotCarryMode === mode ? 'on' : ''}`}
                  style={{ fontSize: 11, padding: '9px 3px', minHeight: 0 }}
                  onPointerDown={() => set('dotCarryMode', mode)}
                >
                  {label}
                  <small>{hint}</small>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <SettingRow label="3 body hits = out" hint="the Body button only appears when this is on">
        <Toggle on={value.threeBodyOut} onTap={flip('threeBodyOut')} />
      </SettingRow>
      <SettingRow
        label="Last man has a partner at the other end"
        hint="he holds the non-striker's end rather than running"
      >
        <Toggle on={value.lastManHasDeadrunner} onTap={flip('lastManHasDeadrunner')} />
      </SettingRow>
      <SettingRow label="Winner chooses next match" hint="from match 2 on, instead of a toss">
        <Toggle on={value.winnerChoosesNextMatch} onTap={flip('winnerChoosesNextMatch')} />
      </SettingRow>
      <SettingRow label="Audio — announce each ball">
        <Toggle on={value.audioPerBall} onTap={flip('audioPerBall')} />
      </SettingRow>
      <SettingRow label="Audio — announce each over">
        <Toggle on={value.audioPerOver} onTap={flip('audioPerOver')} />
      </SettingRow>
    </div>
  );
}
