// Delay 3 editor (FL: Fruity Delay 3, 747 x 217): FL's sections (input,
// delay time, delay model, feedback with feedback distortion, output,
// modulation, diffusion) with every control at the form's coordinates. The
// time wheel shows step dots when tempo-synced and has FL's Right-click > Set
// menu; modulated targets get FL's outlined captions; the distortion display
// draws the transfer curve.

import { d3CutoffText, d3Knee, d3TimeText } from '../../../../model/fx/plugins/delay3';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { Display, FxPanel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { Cap, InputFader, Knob, KnobControl, Led, LIME, Pill, SmoothSlider, warnColor } from './widgets';
import './delay3.css';

/** FL's Set menu (WheelMenu > Set). FL sets the wheel to the item's Tag, so 1/64 and 1/32 give 0:1 and 0:2. */
const SET_ITEMS: [string, number][] = [
  ['1/64', 1], ['1/32', 2], ['1/16', 48], ['1/8', 96], ['1/4', 192], ['1/2', 384],
  ['1/16 dotted', 72], ['1/8 dotted', 144], ['1/4 dotted', 288], ['1/2 dotted', 576],
  ['1/16 triplet', 32], ['1/8 triplet', 64], ['1/4 triplet', 128], ['1/2 triplet', 256],
];

/** One dot per step around the synced time wheel (raw 48 k on the 1..768 range). */
const STEP_DOTS = Array.from({ length: 16 }, (_, i) => (48 * (i + 1) - 1) / 767);

function Section({ x, y, w, h, title, dim, inner }: { x: number; y: number; w: number; h: number; title: string; dim?: boolean; inner?: boolean }) {
  return (
    <>
      <div className="d3-sec" style={{ left: x, top: y, width: w, height: h }} />
      <div className={'d3-title' + (dim ? ' dim' : '') + (inner ? ' inner' : '')} style={{ left: x, top: y, width: w }}>{title}</div>
    </>
  );
}

function TimeKnob() {
  const sync = useParam('sync').value >= 0.5;
  const t = useParam('time', { format: (v) => d3TimeText(v, sync) });
  const set = (v: number) => { t.control.onBegin?.(); t.set(v); t.control.onEnd?.(); };
  const extraMenu: MenuItem[] = sync
    ? [{ label: 'Set', submenu: SET_ITEMS.map(([label, v]) => ({ label, checked: Math.round(t.value) === v, onClick: () => set(v) })) }]
    : [];
  return <KnobControl x={67} y={30} size={64} look="flat" dots={sync ? STEP_DOTS : undefined} control={{ ...t.control, extraMenu }} />;
}

function CutoffKnob() {
  const mode = Math.round(useParam('filterType').value);
  return <Knob k="cutoff" x={452} y={42} size={40} look="metal" control={{ format: (v) => d3CutoffText(v, mode) }} />;
}

/** FEEDBACK DISTORTION display: the unit transfer shape over +-2 (input across, output up). */
function CurveDisplay() {
  const type = useParam('distType').value;
  const knee = useParam('distKnee').value / 6000;
  const sym = useParam('distSym').value / 6000;
  return (
    <Display x={610} y={138} w={70} h={70} deps={[type, knee, sym]} draw={(g, W, H) => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.045)';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(40,48,53,0.32)';
      g.lineWidth = 0.7;
      g.beginPath();
      for (let i = 1; i < 4; i++) {
        const p = Math.round((i * W) / 4) + 0.35;
        g.moveTo(p, 0); g.lineTo(p, H);
        g.moveTo(0, p); g.lineTo(W, p);
      }
      g.stroke();
      const f = (u: number) => {
        if (type < 0.5) return Math.max(-1, Math.min(1, u)); // limiter: a ceiling at the threshold
        if (u >= 0) return (1 + sym) * d3Knee(u / (1 + sym), knee);
        const n = 1 - sym;
        return n <= 0 ? 0 : -n * d3Knee(-u / n, knee);
      };
      g.strokeStyle = LIME;
      g.lineWidth = 1.3;
      g.lineJoin = 'round';
      g.beginPath();
      for (let i = 0; i <= W * 2; i++) {
        const u = -2 + (4 * i) / (W * 2);
        const y = H / 2 - (f(u) / 4) * H;
        if (i === 0) g.moveTo(i / 2, y); else g.lineTo(i / 2, y);
      }
      g.stroke();
    }} />
  );
}

function Delay3Editor() {
  const modTime = useParam('modTime').value > 0;
  const modCut = useParam('modCutoff').value > 0;
  const fbColor = (t: number) => warnColor(t, 0.8); // above 100 % feedback
  const resColor = (t: number) => warnColor(t, 0.75);
  return (
    <FxPanel width={747} height={217} className="d3-panel">
      {/* sections */}
      <Section x={3.3} y={3.3} w={54} h={204} title="INPUT" dim />
      <Section x={59.3} y={3.3} w={193.4} h={110} title="DELAY TIME" />
      <Section x={254.7} y={3.3} w={120.6} h={110} title="DELAY MODEL" />
      <Section x={377.3} y={3.3} w={310} h={204} title="FEEDBACK" />
      <div className="d3-title inner" style={{ left: 381.3, top: 116.7, width: 301.4 }}>FEEDBACK DISTORTION</div>
      <Section x={689.3} y={3.3} w={54.7} h={204} title="OUTPUT" dim />
      <div className="d3-inset" style={{ left: 694.7, top: 29.3, width: 44, height: 120.7 }} />
      <Section x={59.3} y={116.7} w={193.4} h={90.6} title="MODULATION" />
      <Section x={254.7} y={116.7} w={120.6} h={90.6} title="DIFFUSION" />

      {/* input */}
      <InputFader k="inWet" x={11} y={26} w={38} h={153} />
      <Cap x={3.3} y={196} w={54}>WET</Cap>

      {/* delay time */}
      <TimeKnob />
      <Cap x={79} y={96} w={40} boxed={modTime}>TIME</Cap>
      <Led k="sync" x={137} y={35} w={65} h={17} caption="TEMPO SYNC" />
      <Led k="keepPitch" x={137} y={54} w={65} h={17} caption="KEEP PITCH" />
      <SmoothSlider k="smoothing" x={135} y={78} w={71} h={15} />
      <Cap x={130.5} y={96} w={80}>SMOOTHING</Cap>
      <Knob k="offset" x={207} y={42} size={40} look="flat" />
      <Cap x={202} y={96} w={50}>OFFSET</Cap>

      {/* delay model */}
      <Pill k="model" x={258} y={31} trackW={11} h={62} labels={['Mono', 'Stereo', 'Ping pong', 'Off']} labelW={56} />
      <Knob k="spread" x={330} y={42} size={40} look="metal" />
      <Cap x={322} y={96} w={56}>STEREO</Cap>

      {/* feedback */}
      <Knob k="feedback" x={382} y={30} size={64} look="flat" colorOf={fbColor} />
      <Cap x={389} y={96} w={50}>LEVEL</Cap>
      <CutoffKnob />
      <Cap x={451} y={96} w={42} boxed={modCut}>CUTOFF</Cap>
      <Knob k="res" x={499} y={42} size={40} look="metal" colorOf={resColor} />
      <Cap x={494} y={96} w={50}>RES</Cap>
      <Pill k="filterType" x={551} y={31} trackW={11} h={62} labels={['LP', 'HP', 'BP', 'Off']} labelW={30} />
      <Knob k="rate" x={591} y={42} size={40} look="metal" />
      <Cap x={581} y={96} w={60}>SMP RATE</Cap>
      <Knob k="bits" x={639} y={42} size={40} look="metal" />
      <Cap x={634} y={96} w={50}>BITS</Cap>

      {/* feedback distortion */}
      <Pill k="distType" x={384} y={155} trackW={11} h={30} labels={['Limit', 'Sat']} labelW={39} />
      <Knob k="distLevel" x={452} y={150} size={40} look="metal" />
      <Cap x={447} y={196} w={50}>LEVEL</Cap>
      <Knob k="distKnee" x={499} y={150} size={40} look="metal" />
      <Cap x={494} y={196} w={50}>KNEE</Cap>
      <Knob k="distSym" x={550} y={150} size={40} look="metal" />
      <Cap x={535} y={196} w={70}>SYMMETRY</Cap>
      <CurveDisplay />

      {/* modulation */}
      <Knob k="modRate" x={66} y={146} size={48} look="flat" />
      <Cap x={65} y={196} w={50}>RATE</Cap>
      <div className="d3-arrow" style={{ left: 134, top: 165.5 }} />
      <Knob k="modTime" x={156} y={150} size={40} look="metal" />
      <Cap x={156} y={196} w={40} boxed={modTime}>TIME</Cap>
      <Knob k="modCutoff" x={207} y={150} size={40} look="metal" />
      <Cap x={206} y={196} w={42} boxed={modCut}>CUTOFF</Cap>

      {/* diffusion */}
      <Knob k="diffLevel" x={269} y={150} size={40} look="metal" />
      <Cap x={264} y={196} w={50}>LEVEL</Cap>
      <Knob k="diffSpread" x={321} y={150} size={40} look="metal" />
      <Cap x={311} y={196} w={60}>SPREAD</Cap>

      {/* output */}
      <Knob k="wet" x={696} y={31} size={40} look="flat" />
      <Cap x={691} y={73} w={50}>WET</Cap>
      <Knob k="tone" x={696} y={93} size={40} look="flat" />
      <Cap x={691} y={134} w={50}>TONE</Cap>
      <Knob k="dry" x={696} y={155} size={40} look="flat" />
      <Cap x={691} y={195} w={50}>DRY</Cap>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'delay3', Editor: Delay3Editor };
