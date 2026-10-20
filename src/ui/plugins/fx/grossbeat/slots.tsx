// Gross Beat slot selectors: 36 time slots (green) and 36 volume slots
// (orange), 4 x 9 buttons each. Click selects a slot (and its envelope for
// editing), Ctrl+click swaps the selected slot with the clicked one, middle
// click renames, the wheel steps through the slots and right-click opens
// FL's slot menu (Edit slot name, Move slot left / right) with the
// parameter's automation items. While the song plays the playing slot is
// filled and a queued one is outlined.

import { useParam, useFxEditor } from '../../kit';
import { automationMenuItems, autoTargetOf } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { store } from '../../../../store';
import { GB_SLOTS, gbEval, type GbSlot } from '../../../../model/fx/plugins/grossbeat';
import { edit, type Bank } from './edit';

const COLS = 4;
const ROWS = 9;

interface Props {
  x: number;
  y: number;
  w: number;
  h: number;
  bank: Bank;
  slots: GbSlot[];
  /** Playing / queued slot from the engine (-1 when stopped). */
  playing: number;
  pending: number;
  zoom: boolean;
  /** Called after a click selects a slot (switches the envelope editor). */
  onSelect: (i: number) => void;
  linkOther: (i: number) => boolean;
}

export function SlotGrid({ x, y, w, h, bank, slots, playing, pending, zoom, onSelect, linkOther }: Props) {
  const { slotId } = useFxEditor();
  const isTime = bank === 'tslots';
  const p = useParam(isTime ? 'tslot' : 'vslot');
  const other = useParam(isTime ? 'vslot' : 'tslot');
  const cw = w / COLS, ch = h / ROWS;
  const sel = Math.round(p.value);

  const select = (i: number) => {
    store.beginGesture(p.def.name);
    p.set(i);
    if (linkOther(i)) other.set(i);
    store.endGesture();
    onSelect(i);
  };
  const rename = (i: number) => {
    const name = prompt('Slot name', slots[i]?.name ?? '');
    if (name === null) return;
    edit(slotId, 'Rename slot', (st) => { const b = st[bank] as unknown as GbSlot[] | undefined; if (b?.[i]) b[i].name = name.slice(0, 63); });
  };
  const move = (i: number, j: number) => {
    if (j < 0 || j >= GB_SLOTS) return;
    edit(slotId, 'Move slot', (st) => {
      const b = st[bank] as unknown as GbSlot[] | undefined;
      if (!b?.[i] || !b[j]) return;
      const t = b[i]; b[i] = b[j]; b[j] = t;
    });
    if (sel === i) select(j);
  };
  const menu = (e: React.MouseEvent, i: number) => {
    const items: MenuItem[] = [
      { label: 'Reset', onClick: () => select(p.def.def) },
      { label: 'Edit slot name...', onClick: () => rename(i) },
      { label: 'Move slot left', disabled: i === 0, onClick: () => move(i, i - 1) },
      { label: 'Move slot right', disabled: i === GB_SLOTS - 1, onClick: () => move(i, i + 1) },
      { separator: true },
      ...automationMenuItems(autoTargetOf(p.control), e.clientX, e.clientY),
    ];
    openMenu(e.clientX, e.clientY, items);
  };

  const accent = isTime ? 'gb-time' : 'gb-vol';
  return (
    <div className={`fxk-abs gb-slots ${accent}`} style={{ left: x, top: y, width: w, height: h }}
      onWheel={(e) => { e.stopPropagation(); const v = Math.min(GB_SLOTS - 1, Math.max(0, sel + (e.deltaY > 0 ? 1 : -1))); if (v !== sel) select(v); }}
      onPointerLeave={clearHint}>
      {Array.from({ length: GB_SLOTS }, (_, i) => {
        const s = slots[i];
        const cls = ['gb-slot'];
        if (i === sel) cls.push('sel');
        if (i === playing) cls.push('play');
        if (i === pending && pending !== playing) cls.push('queued');
        return (
          <div key={i} className={cls.join(' ')}
            style={{ left: (i % COLS) * cw, top: Math.floor(i / COLS) * ch, width: cw - 1, height: ch - 1 }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button === 1) { e.preventDefault(); rename(i); return; }
              if (e.button !== 0) return;
              if (e.ctrlKey || e.metaKey) {
                // Ctrl: swap the selected slot with the clicked one (the selection follows it)
                if (i !== sel) move(sel, i);
                return;
              }
              select(i);
            }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); menu(e, i); }}
            onPointerEnter={() => setHint(`${p.def.name}: ${s?.name || `Slot ${i + 1}`}`)}>
            {zoom ? <MiniEnv slot={s} w={cw - 1} h={ch - 1} time={isTime} /> : <span className="gb-slot-name">{s?.name ?? ''}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Slot preview drawn instead of the name ("Toggle Envelope Visibility"). */
function MiniEnv({ slot, w, h, time }: { slot: GbSlot | undefined; w: number; h: number; time: boolean }) {
  if (!slot || !Array.isArray(slot.pts) || !slot.pts.length) return null;
  const pts: string[] = [];
  const n = Math.max(8, Math.round(w));
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * 4;
    const v = gbEval(slot.pts, Math.min(3.9999, x));
    const yy = 1 + (h - 2) * (1 - v);
    pts.push(`${((i / n) * w).toFixed(1)},${yy.toFixed(1)}`);
  }
  return (
    <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
      <polyline points={pts.join(' ')} fill="none" stroke={time ? '#b6f76f' : '#ffc977'} strokeWidth={1} />
    </svg>
  );
}
