// Parametric EQ 2 bottom bar (docs/research/peq2.md 5.7, 6.7), left to right:
// name, Options, LIN, HQ, View band tokens, Monitor, Compare.

import { memo, type ReactNode } from 'react';
import { openMenu } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';
import type { PEQ2Monitor, PEQ2Params } from '../../model/peq2';
import { compareStore, compareSwap, editOnce } from './peq2Edit';
import { HQ_MODES, hqMenu, linMenu, optionsMenu } from './peq2Menus';
import type { Layout } from './peq2Layout';

const PRECISION = ['Lowest', 'Low', 'Medium', 'High', 'Higher', 'Highest'];

interface BtnProps {
  hint: string;
  on?: boolean;
  className?: string;
  children: ReactNode;
  onLeft?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onRight?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

function Btn({ hint, on, className, children, onLeft, onRight }: BtnProps) {
  return (
    <button
      type="button"
      className={'peq2-btn' + (on ? ' on' : '') + (className ? ' ' + className : '')}
      onPointerDown={(e) => {
        // Ctrl+click is a right-click on macOS: leave it to onContextMenu
        if (e.button !== 0 || e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        onLeft?.(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRight?.(e);
      }}
      onPointerEnter={() => setHint(hint)}
      onPointerMove={() => setHint(hint)}
      onPointerLeave={clearHint}
    >
      {children}
    </button>
  );
}

const icon = (children: ReactNode, vb = 12) => (
  <svg viewBox={`0 0 ${vb} ${vb}`} aria-hidden="true">{children}</svg>
);

const ICON_OPTIONS = icon(
  <path d="M2 3.2 H10 M2 6 H10 M2 8.8 H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
);
const ICON_CHECK = icon(
  <path d="M2.2 6.4 L4.9 9.1 L9.8 3.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
);
const ICON_STORE = icon(
  <>
    <path d="M6 1.6 V7.4 M3.3 4.9 L6 7.6 L8.7 4.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2.2 10.2 H9.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </>,
);
const ICON_SWAP = icon(
  <path d="M4 10.2 V1.9 M1.9 4 L4 1.9 L6.1 4 M8 1.8 V10.1 M5.9 8 L8 10.1 L10.1 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
);

const MONITOR: { value: PEQ2Monitor; hint: string; icon: ReactNode }[] = [
  { value: 'off', hint: 'Monitor: off', icon: icon(<path d="M2.5 6 H9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />) },
  { value: 'input', hint: 'Monitor: input (analyzer shows the signal before the EQ)', icon: icon(<path d="M6 2.2 V9.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />) },
  { value: 'output', hint: 'Monitor: output (analyzer shows the signal after the EQ)', icon: icon(<circle cx="6" cy="6" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" />) },
];

export const PEQ2Bottom = memo(function PEQ2Bottom({ slotId, params: p, lay }: { slotId: string; params: PEQ2Params; lay: Layout }) {
  const hq = HQ_MODES.find((m) => m.mode === p.hqMode) ?? HQ_MODES[2];
  const menuAt = (e: { currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [r.left, r.bottom + 1] as const;
  };
  return (
    <div className="peq2-bottom" style={{ top: lay.topH, height: lay.bottomH, width: lay.W, fontSize: `${Math.max(7, 10 * lay.s)}px` }}>
      <div className="peq2-name">PARAMETRIC <b>EQ 2</b></div>
      <Btn
        hint="Options"
        className="peq2-btn-icon"
        onLeft={(e) => { const [x, y] = menuAt(e); openMenu(x, y, optionsMenu(slotId, p), { minWidth: 170 }); }}
        onRight={(e) => openMenu(e.clientX, e.clientY, optionsMenu(slotId, p), { minWidth: 170 })}
      >
        {ICON_OPTIONS}
      </Btn>
      <Btn
        on={p.lin}
        hint={`Linear phase: ${p.lin ? 'on' : 'off'}, precision ${PRECISION[p.linPrecision] ?? 'Medium'} (right-click for precision)`}
        onLeft={() => editOnce(slotId, 'Linear phase', (d) => { d.lin = !d.lin; })}
        onRight={(e) => openMenu(e.clientX, e.clientY, linMenu(slotId, p))}
      >
        LIN
      </Btn>
      <Btn
        on={p.hq}
        hint={`HQ: ${p.hq ? 'on' : 'off'}, ${hq.label} - ${hq.desc} (right-click for mode)`}
        onLeft={() => editOnce(slotId, 'HQ', (d) => { d.hq = !d.hq; })}
        onRight={(e) => openMenu(e.clientX, e.clientY, hqMenu(slotId, p))}
      >
        HQ<sub>{hq.sub}</sub>
      </Btn>
      <Btn
        on={p.showTokens}
        className="peq2-btn-icon"
        hint={`View band tokens: ${p.showTokens ? 'on' : 'off'}`}
        onLeft={() => editOnce(slotId, 'View band tokens', (d) => { d.showTokens = !d.showTokens; })}
      >
        {ICON_CHECK}
      </Btn>
      <div className="peq2-spacer" />
      <div className="peq2-group">
        <div className="peq2-group-row">
          {MONITOR.map((m) => (
            <Btn key={m.value} on={p.monitor === m.value} hint={m.hint} className="peq2-btn-sm"
              onLeft={() => { if (p.monitor !== m.value) editOnce(slotId, 'Monitor', (d) => { d.monitor = m.value; }); }}>
              {m.icon}
            </Btn>
          ))}
        </div>
        <div className="peq2-group-cap">MONITOR</div>
      </div>
      <div className="peq2-group">
        <div className="peq2-group-row">
          <Btn
            className={'peq2-btn-sm' + (p.opts.lockSpare ? ' locked' : '')}
            hint={p.opts.lockSpare ? 'Compare: store is locked (Options > Lock spare state)' : 'Compare: copy the current settings to the spare state'}
            onLeft={() => compareStore(slotId)}
          >
            {ICON_STORE}
          </Btn>
          <Btn
            on={p.onSpare}
            className="peq2-btn-sm"
            hint={`Compare: swap the current settings and the spare state (${p.onSpare ? 'showing spare' : 'showing main'})`}
            onLeft={() => compareSwap(slotId)}
          >
            {ICON_SWAP}
          </Btn>
        </div>
        <div className="peq2-group-cap">COMPARE</div>
      </div>
    </div>
  );
});
