// Balance editor (FL: Fruity Balance, 227 x 148): balance and volume knobs in
// FL's classic vector style with value texts, and a stereo peak meter.

import { useRef } from 'react';
import { balanceText, volumeText } from '../../../model/fx/plugins/balance';
import { AnimatedDisplay, FxPanel, Label, Wheel, useFxEditor, useFxMonitor, useParam } from '../kit';
import type { FxEditorModule } from '../registry';

const DB_MARKS = [0, 6, 12, 18, 24, 30, 39];

/** Meter height fraction for a linear peak (FL's volumeter scale: compressed toward the bottom). */
function meterFrac(a: number): number {
  return Math.min(1, Math.pow(Math.max(0, a) / 1.41, 0.32));
}

function Meter({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const st = useRef({ l: 0, r: 0, hl: 0, hr: 0, tl: 0, tr: 0, last: 0 });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    s.l = Math.max(s.l, Number(d.peakL) || 0);
    s.r = Math.max(s.r, Number(d.peakR) || 0);
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W, H, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      // ballistics: instant attack, ~20 dB/s fall, 1.5 s peak hold
      const fall = Math.pow(10, (-20 * dt) / 20);
      const show = (v: number) => v;
      g.fillStyle = '#1e2225';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = '#3a4045';
      g.strokeRect(0.5, 0.5, W - 1, H - 1);
      const top = 6, bot = H - 4, span = bot - top;
      const bw = Math.round(W * 0.28);
      const xl = Math.round(W * 0.14), xr = W - xl - bw;
      for (const [k, x0] of [['l', xl], ['r', xr]] as const) {
        const v = show(k === 'l' ? s.l : s.r);
        const f = meterFrac(v);
        g.fillStyle = '#c8f04c';
        g.fillRect(x0, bot - f * span, bw, f * span);
        const hk = k === 'l' ? 'hl' : 'hr', tk = k === 'l' ? 'tl' : 'tr';
        if (v >= s[hk]) { s[hk] = v; s[tk] = t; }
        else if (t - s[tk] > 1500) s[hk] *= fall;
        const hf = meterFrac(s[hk]);
        g.fillStyle = '#d8a53a';
        g.fillRect(x0, Math.round(bot - hf * span), bw, 2);
      }
      s.l *= fall; s.r *= fall;
      // dB scale between the bars
      g.font = '9px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const db of DB_MARKS) {
        const yy = bot - meterFrac(Math.pow(10, -db / 20)) * span;
        g.fillStyle = db === 0 ? '#e8eef1' : '#7f8a90';
        g.fillText(String(db), W / 2, yy);
        g.fillStyle = '#4a5156';
        g.fillRect(4, Math.round(yy), 4, 1);
        g.fillRect(W - 8, Math.round(yy), 4, 1);
      }
    }} />
  );
}

function BalanceEditor() {
  const pan = useParam('pan');
  const vol = useParam('vol');
  return (
    <FxPanel width={227} height={148} style={{ background: 'radial-gradient(120% 90% at 50% 0%, #3b4146 0%, #2b3034 60%, #24282b 100%)' }}>
      <Label x={5} y={16} w={87} h={22} size={17} color="#c9d1d6" style={{ textTransform: 'none' }}>Balance</Label>
      <Label x={134} y={16} w={83} h={22} size={17} color="#c9d1d6" style={{ textTransform: 'none' }}>Volume</Label>
      <Wheel k="pan" x={20} y={48} size={56} look="classic" color="#8a63d2" />
      <Wheel k="vol" x={148} y={48} size={56} look="classic" color="#3ec7f0" />
      <Label x={10} y={110} w={74} h={24} size={12} color="#c9d1d6" style={{ textTransform: 'none' }}>{balanceText(pan.value)}</Label>
      <Label x={128} y={110} w={96} h={24} size={12} color="#c9d1d6" style={{ textTransform: 'none' }}>{volumeText(vol.value).replace(' ', ' ')}</Label>
      <Meter x={89} y={16} w={46} h={118} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'balance', Editor: BalanceEditor };
