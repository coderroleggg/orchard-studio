// The NoteBooks' bottom strip: FL's TNumBar page selector ("Page index",
// automatable: drag, wheel, arrows, right-click menu) and the pencil button
// that enables editing (FL's EnableBtn; the notes are read-only otherwise).

import { useParam } from '../../kit';
import { useControl } from '../../../widgets/control';
import { clearHint, setHint } from '../../../hint';

const INK = '#2b2f33';
const ARROW = '#6f7478';

export function PageBar({ y, width, editX, editing, onToggleEdit }: {
  y: number; width: number; editX: number; editing: boolean; onToggleEdit: () => void;
}) {
  const p = useParam('page');
  const h = useControl({ travel: 600, ...p.control }, 'horizontal');
  const page = Math.round(p.value);
  const step = (d: number) => {
    const v = Math.max(p.def.min, Math.min(p.def.max, page + d));
    if (v !== page) { p.control.onBegin?.(); p.set(v); p.control.onEnd?.(); }
  };
  const chevron = (dir: -1 | 1) => (
    <svg width={8} height={19} viewBox="0 0 8 19" style={{ position: 'absolute', top: 0, [dir < 0 ? 'left' : 'right']: 3 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); step(dir); } }}>
      <path d={dir < 0 ? 'M5.6 5.6 L2.4 9.8 L5.6 14' : 'M2.4 5.6 L5.6 9.8 L2.4 14'} stroke={ARROW} strokeWidth={1.1} fill="none" />
    </svg>
  );
  return (
    <>
      <div className="fxk-abs" style={{ left: 0, top: y, width, height: 19, cursor: 'ew-resize', touchAction: 'none' }}
        {...h} onPointerEnter={() => setHint(`Page index: ${page}`)} onPointerLeave={clearHint}>
        {chevron(-1)}
        <span style={{ position: 'absolute', left: 25, top: 0, lineHeight: '19px', font: '300 17px var(--font-ui)', color: INK, pointerEvents: 'none' }}>{page}</span>
        {chevron(1)}
      </div>
      <div className="fxk-abs" style={{ left: editX, top: y, width: 21, height: 19, borderRadius: 4, background: editing ? 'rgba(0,0,0,0.13)' : undefined, boxShadow: editing ? 'inset 0 0 0 1px rgba(0,0,0,0.28)' : undefined, cursor: 'default' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggleEdit(); } }}
        onPointerEnter={() => setHint('Enable editing')} onPointerLeave={clearHint}>
        <svg width={21} height={19} viewBox="0 0 21 19" style={{ display: 'block' }}>
          <g fill="none" stroke="#1f2225" strokeWidth={1.25} strokeLinejoin="round">
            <path d="M5 13.6 L13.4 5.2 L16.4 8.2 L8 16.6 L4.6 17 Z" />
            <path d="M11.8 6.8 L14.8 9.8" />
            <path d="M5 13.6 L8 16.6" />
          </g>
        </svg>
      </div>
    </>
  );
}
