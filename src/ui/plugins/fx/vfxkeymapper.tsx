// VFX Key Mapper editor (FL: 775 x 373). The note matrix (MapVisual 8,16
// 759x239): input pitch classes C..B bottom to top (labelled from the Base
// key), output notes over three octaves (-12..+23 semitones), the middle
// octave lighter; mapped notes are orange when unchanged and red when moved,
// labelled with the output note. Left-click toggles a note, right-click makes
// it the row's only note, middle-click resets the matrix (FL's manual).
// Below: Base key, Offset, Multi mode and Pitch slide; Enable in the title band.

import { Display, FxPanel, Label, useFxEdit, useFxEditor, useFxState } from '../kit';
import type { FxEditorModule } from '../registry';
import { clearHint, setHint } from '../../hint';
import { KEY_NAMES, MAP_LO, MULTI_MODES, identityMap, normalizeMap, type KeyMap } from '../../../model/fx/plugins/vfxkeymapper';
import { CANVAS_FONT, DARK_COMBO, DARK_COMBO_STYLE, LedSwitch, ParamCombo, TickSlider, VfxTitle } from './vfx/common';

const MX = 8, MY = 16, MW = 759, MH = 239;
const LW = 40;
const COLS = 36;
const CW = (MW - LW) / COLS;
const RH = MH / 12;
const BLACK = new Set([1, 3, 6, 8, 10]);

const rgb = (v: [number, number, number]) => `rgb(${v[0]},${v[1]},${v[2]})`;

function cellColor(row: number, col: number): string {
  const d = (BLACK.has(col % 12) ? 16 : 0) + (BLACK.has(row) ? 16 : 0) - (col >= 12 && col < 24 ? 32 : 0);
  return rgb([0xc3 - d, 0xc7 - d, 0xce - d]);
}

function Matrix() {
  const editFx = useFxEdit();
  const raw = useFxState<KeyMap>('map', identityMap());
  const map = normalizeMap(raw);
  const base = Math.round(Number(useFxEditor().params.base ?? 0)) || 0;
  const name = (pc: number) => KEY_NAMES[(((pc + base) % 12) + 12) % 12];
  const edit = (label: string, f: (m: KeyMap) => KeyMap) => editFx(label, (p) => { p.map = f(normalizeMap(p.map)); });
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / MW;
    const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
    if (x < LW) return null;
    const col = Math.floor((x - LW) / CW), row = 11 - Math.floor(y / RH);
    if (col < 0 || col >= COLS || row < 0 || row > 11) return null;
    return { row, col, e: col + MAP_LO };
  };
  return (
    <Display x={MX} y={MY} w={MW} h={MH} deps={[JSON.stringify(map), base]}
      onPointerDown={(e) => {
        const c = at(e);
        e.stopPropagation();
        if (e.button === 1) { e.preventDefault(); edit('Reset key map', () => identityMap()); return; }
        if (!c) return;
        if (e.button === 2) { edit('Key map', (m) => { m[c.row] = [c.e]; return m; }); return; }
        if (e.button === 0) edit('Key map', (m) => { const r = m[c.row]; m[c.row] = r.includes(c.e) ? r.filter((v) => v !== c.e) : [...r, c.e]; return m; });
      }}
      onPointerMove={(e) => {
        const c = at(e);
        if (!c) { clearHint(); return; }
        const outPc = ((c.e % 12) + 12) % 12, oct = Math.floor(c.e / 12);
        setHint(`${name(c.row)} -> ${name(outPc)}${oct < 0 ? ' (octave down)' : oct > 0 ? ' (octave up)' : ''} - click to add / remove, right-click to replace, middle-click to reset`);
      }}
      onContextMenu={(e) => e.preventDefault()}
      draw={(g, w, h) => {
        g.fillStyle = '#8b9198';
        g.fillRect(0, 0, w, h);
        g.font = `14px ${CANVAS_FONT}`;
        g.textBaseline = 'middle';
        for (let row = 0; row < 12; row++) {
          const y = (11 - row) * RH;
          // label cell
          g.fillStyle = BLACK.has(row) ? '#555a61' : '#63676e';
          g.fillRect(0, Math.round(y), LW - 1, Math.round(y + RH) - Math.round(y) - 1);
          g.fillStyle = '#eef1f3';
          g.textAlign = 'right';
          g.fillText(name(row), LW - 5, y + RH / 2 + 0.5);
          for (let col = 0; col < COLS; col++) {
            const x0 = Math.round(LW + col * CW), x1 = Math.round(LW + (col + 1) * CW);
            const y0 = Math.round(y), y1 = Math.round(y + RH);
            g.fillStyle = cellColor(row, col);
            g.fillRect(x0, y0, x1 - x0 - 1, y1 - y0 - 1);
          }
        }
        // mapped notes
        g.font = `13px ${CANVAS_FONT}`;
        g.textAlign = 'center';
        for (let row = 0; row < 12; row++) {
          const y0 = Math.round((11 - row) * RH), y1 = Math.round((12 - row) * RH);
          for (const e of map[row]) {
            const col = e - MAP_LO;
            const x0 = Math.round(LW + col * CW), x1 = Math.round(LW + (col + 1) * CW);
            const same = e === row;
            const dark = BLACK.has(row);
            g.fillStyle = same ? (dark ? '#e2a35f' : '#ffcf8b') : (dark ? '#dd8a8d' : '#f1a1a3');
            g.fillRect(x0, y0, x1 - x0 - 1, y1 - y0 - 1);
            g.strokeStyle = same ? (dark ? '#b57a3d' : '#d9a464') : (dark ? '#b2595d' : '#cf7b7f');
            g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 2, y1 - y0 - 2);
            g.fillStyle = same ? '#5b4029' : '#5d3637';
            g.fillText(name(((e % 12) + 12) % 12), (x0 + x1 - 1) / 2, (y0 + y1 - 1) / 2 + 0.5);
          }
        }
      }} />
  );
}

function KeyMapperEditor() {
  return (
    <FxPanel width={775} height={373} style={{ background: '#3f484d' }}>
      <div className="fxk-abs" style={{ left: 7, top: 15, width: 761, height: 241, background: '#2b3236', borderRadius: 2 }} />
      <Matrix />
      <Label x={13} y={278} w={46} h={16} size={12} color="#e6eaee" align="left" style={{ textTransform: 'none', overflow: 'visible' }}>Base key</Label>
      <ParamCombo k="base" x={64} y={275} w={36} h={22} look={DARK_COMBO} style={DARK_COMBO_STYLE} />
      <Label x={142} y={278} w={32} h={15} size={12} color="#e6eaee" align="left" style={{ textTransform: 'none', overflow: 'visible' }}>Offset</Label>
      <TickSlider k="offset" x={177} y={271} w={119} h={26} ticks={24} />
      <Label x={359} y={278} w={61} h={16} size={12} color="#e6eaee" align="right" style={{ textTransform: 'none', overflow: 'visible' }}>Multi mode</Label>
      <ParamCombo k="mode" x={425} y={275} w={132} h={22} look={DARK_COMBO} style={DARK_COMBO_STYLE} options={MULTI_MODES} />
      <Label x={609} y={278} w={64} h={16} size={12} color="#e6eaee" align="right" style={{ textTransform: 'none', overflow: 'visible' }}>Pitch slide</Label>
      <TickSlider k="slide" x={677} y={271} w={87} h={26} ticks={4} mark="#e0262d" />
      <VfxTitle y={317} w={775} h={56} name="Key Mapper" />
      <LedSwitch k="enable" x={680} y={347} w={86} h={17} caption="Enable" />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vfxkeymapper', Editor: KeyMapperEditor };
