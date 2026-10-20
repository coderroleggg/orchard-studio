// Sakura's artwork, drawn by code (FL draws it from bitmaps; this is an original drawing in the same
// colours): the crimson top and bottom bands with the cherry blossom logo, the silver panel with its
// black bars, the dark modulation strip, the level meter's dial and needle, the hint display and the
// string / damper illustration (FL's DampingPaintBox).

import { memo, useEffect, useRef } from 'react';
import { useFxEditor, useFxMonitor, useParam } from '../../kit';
import { arc, pol } from './skin';
import { useSkHint } from './hint';
import { CAPTIONS, H, HINT_BOX, METER_BOX, SLOTS, STRING_BOX, W } from './layout';

type Stop = [number, string];

function Grad({ id, stops, x2 = 0, y2 = 1 }: { id: string; stops: Stop[]; x2?: number; y2?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2={x2} y2={y2}>
      {stops.map(([o, c], i) => <stop key={i} offset={o} stopColor={c} />)}
    </linearGradient>
  );
}

function Radial({ id, stops, cx = 0.4, cy = 0.3, r = 0.8 }: { id: string; stops: Stop[]; cx?: number; cy?: number; r?: number }) {
  return (
    <radialGradient id={id} cx={cx} cy={cy} r={r}>
      {stops.map(([o, c], i) => <stop key={i} offset={o} stopColor={c} />)}
    </radialGradient>
  );
}

/** Every gradient of the editor (referenced by id from the controls' drawings too). */
function Defs() {
  return (
    <defs>
      {/* the crimson bands: a spotlight from the middle (sampled from FL's thumbnail) */}
      <Grad id="skBand" x2={1} y2={0} stops={[
        [0, '#571a2b'], [0.02, '#5a1a2d'], [0.08, '#5d1c2f'], [0.12, '#651f32'], [0.156, '#6c2137'], [0.194, '#78253d'], [0.27, '#912f4e'],
        [0.35, '#b73d61'], [0.437, '#e04b7a'], [0.505, '#eb547f'], [0.58, '#d54971'], [0.68, '#a43757'], [0.777, '#7d2942'],
        [0.874, '#641f33'], [0.92, '#5d1b2f'], [0.962, '#591a2c'], [1, '#58182b'],
      ]} />
      <Grad id="skBandShade" stops={[[0, 'rgba(0,0,0,0.30)'], [0.14, 'rgba(0,0,0,0)'], [0.78, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.26)']]} />
      <Grad id="skZone" stops={[[0, '#6d6e73'], [0.03, '#85868c'], [0.5, '#7a7b81'], [1, '#72737a']]} />
      <Grad id="skLight" stops={[[0, '#a1a3aa'], [1, '#8e8f96']]} />
      <Grad id="skRes" stops={[[0, '#86878e'], [1, '#75767d']]} />
      <Grad id="skMid" stops={[[0, '#d8dae1'], [0.5, '#cbcdd4'], [1, '#c0c2c9']]} />
      <Grad id="skBox" stops={[[0, '#97989e'], [1, '#808188']]} />
      <Grad id="skBlack" stops={[[0, '#13131c'], [1, '#09090e']]} />
      <Grad id="skPlate" stops={[[0, '#85868d'], [1, '#717279']]} />
      <Grad id="skStrip" stops={[[0, '#3a3c45'], [1, '#2b2d34']]} />
      <Grad id="skDisplay" stops={[[0, '#2e2f36'], [1, '#18191e']]} />
      <Grad id="skFrame" stops={[[0, '#e6e7eb'], [0.5, '#c5c6cc'], [1, '#a2a3aa']]} />
      <Grad id="skSlot" stops={[[0, '#2d2d33'], [1, '#1c1c21']]} />
      <Grad id="skBar" stops={[[0, '#ffffff'], [0.5, '#e1e2e6'], [1, '#b4b5bc']]} />
      <Grad id="skBarDim" stops={[[0, '#d2d3d8'], [0.5, '#b3b4bb'], [1, '#8c8d95']]} />
      <Grad id="skHandle" stops={[[0, '#efeff3'], [1, '#a6a7ae']]} />
      <Grad id="skCoil" stops={[[0, '#6b3410'], [0.28, '#d98a2e'], [0.5, '#ffd68a'], [0.72, '#d98a2e'], [1, '#6b3410']]} />
      <Grad id="skBridge" stops={[[0, '#dedfe4'], [1, '#a3a4ab']]} />
      <Grad id="skLogoText" stops={[[0, '#fff2f5'], [1, '#f0b6c6']]} />
      <Grad id="skDamper" stops={[[0, 'rgba(250,160,60,0.9)'], [1, 'rgba(250,160,60,0.18)']]} />
      <linearGradient id="skDamperUp" x1="0" y1="1" x2="0" y2="0">
        <stop offset={0} stopColor="rgba(250,160,60,0.9)" />
        <stop offset={1} stopColor="rgba(250,160,60,0.18)" />
      </linearGradient>
      <Radial id="skChrome" cx={0.38} cy={0.3} r={0.8} stops={[[0, '#fdfdfe'], [0.3, '#dadbe0'], [0.65, '#a4a5ac'], [1, '#72737b']]} />
      <Radial id="skDark" cx={0.4} cy={0.3} r={0.85} stops={[[0, '#4c4d55'], [0.5, '#25262c'], [1, '#0f0f13']]} />
      <Radial id="skTan" cx={0.4} cy={0.35} r={0.75} stops={[[0, '#fbefc7'], [0.55, '#d2b87e'], [1, '#8e7040']]} />
      <Radial id="skStripBody" cx={0.4} cy={0.3} r={0.9} stops={[[0, '#43454e'], [1, '#17181d']]} />
      <Radial id="skCapSilver" cx={0.4} cy={0.3} r={0.8} stops={[[0, '#ffffff'], [0.5, '#cfd0d6'], [1, '#8f9098']]} />
      <Radial id="skLedOn" cx={0.45} cy={0.4} r={0.7} stops={[[0, '#ffe9ee'], [0.35, '#f27a96'], [1, '#b3203f']]} />
      <Radial id="skLedOff" cx={0.45} cy={0.4} r={0.8} stops={[[0, '#4a4a50'], [1, '#222226']]} />
      <Radial id="skAnchor" cx={0.4} cy={0.35} r={0.75} stops={[[0, '#6a6b72'], [1, '#1d1e22']]} />
      <Radial id="skPetal" cx={0.5} cy={0.85} r={0.95} stops={[[0, '#ffffff'], [0.55, '#f8d6e0'], [1, '#e39ab0']]} />
    </defs>
  );
}

/** One cherry blossom: five notched petals around a crimson centre, radius ~26 around (cx, cy). */
function Blossom({ cx, cy, k = 1, o = 1, rot = 0 }: { cx: number; cy: number; k?: number; o?: number; rot?: number }) {
  const petal = 'M0 -2 C-8 -6 -13 -16 -9 -23 C-7.5 -25.5 -4.5 -26 -2.5 -24.3 L0 -21.6 L2.5 -24.3 C4.5 -26 7.5 -25.5 9 -23 C13 -16 8 -6 0 -2 Z';
  return (
    <g transform={`translate(${cx} ${cy}) rotate(${rot}) scale(${k})`} opacity={o}>
      {[0, 72, 144, 216, 288].map((a) => (
        <g key={a} transform={`rotate(${a})`}>
          <path d={petal} fill="url(#skPetal)" stroke="rgba(150,40,70,0.38)" strokeWidth={0.5} />
          <path d="M0 -4 L0 -16 M0 -9 L-3 -14 M0 -9 L3 -14" stroke="rgba(196,76,106,0.5)" strokeWidth={0.55} fill="none" />
        </g>
      ))}
      <circle r={4.4} fill="#a3213f" />
      {[0, 51, 103, 154, 206, 257, 309].map((a) => {
        const [x, y] = pol(0, 9.2, a);
        const [x0, y0] = pol(0, 3.6, a);
        return (
          <g key={a}>
            <line x1={x0} y1={y0} x2={x} y2={y} stroke="#c23356" strokeWidth={0.8} />
            <circle cx={x} cy={y} r={1.1} fill="#f7dde4" />
          </g>
        );
      })}
    </g>
  );
}

const SLOT_X = SLOTS.map((s) => s.comboX - 5);

/** The panel's static drawing (everything except the controls, the string illustration and the needle). */
export const Backdrop = memo(function Backdrop() {
  const m = METER_BOX;
  const dialArc = (a0: number, a1: number, r = 24) => arc(0, r, a0, a1);
  return (
    <svg className="sk-art" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <Defs />

      {/* ---- silver zone (Touch / Vibration / String interaction / Resonance) */}
      <rect x={0} y={70} width={W} height={292} fill="url(#skZone)" />
      <rect x={541} y={70} width={149} height={292} fill="url(#skLight)" />
      <rect x={690} y={70} width={165} height={292} fill="url(#skRes)" />
      <rect x={690} y={70} width={1} height={292} fill="rgba(0,0,0,0.22)" />
      <rect x={691} y={70} width={1} height={292} fill="rgba(255,255,255,0.16)" />

      {/* exciter column: emblem box, black slider bar, noise rate box */}
      <path d="M0 96H54a8 8 0 0 1 8 8V145a8 8 0 0 1-8 8H0Z" fill="url(#skBox)" stroke="rgba(0,0,0,0.38)" />
      <path d="M1 97.5H53" stroke="rgba(255,255,255,0.4)" />
      <g transform="translate(31 124)">
        <circle r={14.5} fill="rgba(0,0,0,0.10)" stroke="rgba(40,41,48,0.55)" strokeWidth={1.2} />
        <path d="M0 -10C5 -10 8 -5 6 1C5 5 2 8 0 10C-2 8 -5 5 -6 1C-8 -5 -5 -10 0 -10Z" fill="#2c2d34" />
        <path d="M-11 -3.5A12 12 0 0 0 -11 3.5M11 -3.5A12 12 0 0 1 11 3.5" stroke="rgba(40,41,48,0.7)" strokeWidth={1.1} fill="none" />
      </g>
      <rect x={0} y={153} width={63} height={126} fill="url(#skBlack)" stroke="rgba(200,201,208,0.55)" />
      <path d="M0 281H54a8 8 0 0 1 8 8V338a8 8 0 0 1-8 8H0Z" fill="url(#skBox)" stroke="rgba(0,0,0,0.38)" />
      <path d="M1 282.5H53" stroke="rgba(255,255,255,0.4)" />

      {/* hi-cut / lo-cut separator */}
      <rect x={80} y={283} width={117} height={1} fill="rgba(0,0,0,0.26)" />
      <rect x={80} y={284} width={117} height={1} fill="rgba(255,255,255,0.22)" />

      {/* string block: silver middle, black bars with outward rounded corners */}
      <rect x={275} y={100} width={207} height={235} fill="url(#skMid)" />
      <rect x={275} y={100} width={207} height={1} fill="rgba(255,255,255,0.75)" />
      <rect x={275} y={334} width={207} height={1} fill="rgba(0,0,0,0.25)" />
      <path d="M275 100H228a14 14 0 0 0-14 14V321a14 14 0 0 0 14 14H275Z" fill="url(#skBlack)" stroke="rgba(255,255,255,0.1)" />
      <path d="M482 100H529a14 14 0 0 1 14 14V321a14 14 0 0 1-14 14H482Z" fill="url(#skBlack)" stroke="rgba(255,255,255,0.1)" />
      <rect x={221} y={203} width={44} height={34} rx={4} fill="#1d1e26" stroke="#35363f" />

      {/* resonator: dark bar with the feedback knobs, plate under the frequency sliders */}
      <rect x={692} y={97} width={44} height={244} rx={10} fill="url(#skBlack)" stroke="rgba(255,255,255,0.09)" />
      <rect x={738} y={100} width={110} height={238} rx={5} fill="rgba(255,255,255,0.06)" stroke="rgba(0,0,0,0.22)" />

      {/* ---- modulation strip */}
      <rect x={0} y={359} width={W} height={83} fill="url(#skStrip)" />
      <rect x={0} y={359} width={W} height={3} fill="rgba(0,0,0,0.55)" />
      <rect x={0} y={362} width={W} height={1} fill="rgba(255,255,255,0.07)" />
      <rect x={8} y={366} width={172} height={71} rx={5} fill="rgba(0,0,0,0.13)" stroke="rgba(255,255,255,0.05)" />
      <rect x={184} y={366} width={45} height={71} rx={5} fill="rgba(0,0,0,0.13)" stroke="rgba(255,255,255,0.05)" />
      {SLOT_X.map((x) => <rect key={x} x={x} y={366} width={72} height={71} rx={5} fill="rgba(0,0,0,0.13)" stroke="rgba(255,255,255,0.05)" />)}

      {/* ---- acoustics band (delay / chorus / reverb) */}
      <rect x={0} y={442} width={W} height={90} fill="url(#skBand)" />
      <rect x={0} y={442} width={W} height={90} fill="url(#skBandShade)" />
      <rect x={0} y={442} width={W} height={1} fill="rgba(0,0,0,0.55)" />
      {[452, 650].map((x) => (
        <g key={x}>
          <rect x={x} y={450} width={1} height={78} fill="rgba(50,4,22,0.5)" />
          <rect x={x + 1} y={450} width={1} height={78} fill="rgba(255,170,195,0.22)" />
        </g>
      ))}
      <rect x={84} y={477} width={44} height={31} rx={4} fill="rgba(18,10,16,0.62)" stroke="rgba(0,0,0,0.5)" />

      {/* ---- top band: logo, hint display, meter */}
      <rect x={0} y={0} width={W} height={71} fill="url(#skBand)" />
      <rect x={0} y={0} width={W} height={71} fill="url(#skBandShade)" />
      <rect x={0} y={70} width={W} height={1} fill="rgba(30,4,14,0.6)" />
      <rect x={0} y={71} width={W} height={5} fill="rgba(0,0,0,0.22)" />
      <Blossom cx={101} cy={53} k={0.3} o={0.2} rot={20} />
      <Blossom cx={215} cy={14} k={0.34} o={0.14} rot={-12} />
      <Blossom cx={38} cy={36} k={1} />
      <text x={78} y={47} className="sk-logo" fill="rgba(70,6,28,0.55)" transform="translate(1.2 1.4)">SAKURA</text>
      <text x={78} y={47} className="sk-logo" fill="url(#skLogoText)">SAKURA</text>

      <circle cx={713} cy={34} r={21.5} fill="rgba(48,6,22,0.55)" stroke="rgba(30,3,12,0.6)" strokeWidth={1.2} />
      <rect x={HINT_BOX.x} y={HINT_BOX.y} width={HINT_BOX.w} height={HINT_BOX.h} rx={5} fill="url(#skDisplay)" stroke="#09090c" />
      <rect x={HINT_BOX.x + 1} y={HINT_BOX.y + 1} width={HINT_BOX.w - 2} height={1} fill="rgba(255,255,255,0.10)" />

      <g transform={`translate(${m.x} ${m.y})`}>
        <rect width={m.w} height={m.h} rx={4} fill="#09090c" stroke="rgba(255,255,255,0.16)" />
        <rect x={1} y={1} width={m.w - 2} height={16} rx={3} fill="rgba(255,255,255,0.05)" />
        <g transform="translate(34.5 36)">
          <path d={dialArc(-54, 24)} stroke="#d98a3e" strokeWidth={2.2} fill="none" />
          <path d={dialArc(24, 54)} stroke="#e0405f" strokeWidth={2.2} fill="none" />
          {[-54, -36, -18, 0, 18, 36, 54].map((a) => {
            const [x0, y0] = pol(0, 20, a);
            const [x1, y1] = pol(0, 22.6, a);
            return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#c9cad3" strokeWidth={0.8} />;
          })}
        </g>
      </g>

      {/* ---- captions */}
      {CAPTIONS.map((c, i) => (
        <text key={i} x={c.x} y={c.y} className={`sk-cap sk-t-${c.tone}${c.title ? ' sk-title' : ''}`}>{c.t}</text>
      ))}
    </svg>
  );
});

// ------------------------------------------------------------------ level meter needle
/** Dial angle (degrees from straight up) of a peak level: 0 dB at +24 degrees, where the red zone starts. */
export function needleAngle(peak: number): number {
  const db = peak > 1e-5 ? 20 * Math.log10(peak) : -100;
  const f = Math.min(1, Math.max(0, 0.77 + db * 0.0171));
  return -54 + 108 * f;
}

/** The meter's needle (FL's TWAVVolumeter): follows the instrument's peak level (monitor { l, r }); rests at zero without data. */
export function MeterNeedle() {
  const { slotId } = useFxEditor();
  const line = useRef<SVGLineElement>(null);
  const st = useRef({ target: -54, shown: -54, last: 0 });
  useFxMonitor(slotId, (d) => {
    const l = Number(d.l), r = Number(d.r);
    const peak = Math.max(Number.isFinite(l) ? l : 0, Number.isFinite(r) ? r : 0);
    st.current.target = needleAngle(peak);
    st.current.last = performance.now();
  });
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = st.current;
      if (performance.now() - s.last > 150) s.target = Math.max(-54, s.target - 4);
      const k = s.target > s.shown ? 0.4 : 0.08;
      const next = s.shown + (s.target - s.shown) * k;
      if (Math.abs(next - s.shown) < 0.02) return;
      s.shown = next;
      line.current?.setAttribute('transform', `rotate(${next.toFixed(2)} 34.5 36)`);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <svg className="sk-art" style={{ left: METER_BOX.x, top: METER_BOX.y }} width={METER_BOX.w} height={METER_BOX.h} viewBox={`0 0 ${METER_BOX.w} ${METER_BOX.h}`} aria-hidden="true">
      <line ref={line} x1={34.5} y1={36} x2={34.5} y2={12} stroke="#eceef4" strokeWidth={1} strokeLinecap="round" transform="rotate(-54 34.5 36)" />
      <circle cx={34.5} cy={36} r={3} fill="#1a1a1f" stroke="#41424b" />
    </svg>
  );
}

// ------------------------------------------------------------------ hint display
/** FL's HintLabel: the name and value of the control being touched, "---" otherwise. */
export function HintDisplay() {
  const h = useSkHint();
  return (
    <div className="sk-hint" style={{ left: HINT_BOX.x, top: HINT_BOX.y, width: HINT_BOX.w, height: HINT_BOX.h }}>
      {h ? (
        <>
          <div className="sk-hint-name">{h.name}</div>
          {h.text !== '' && <div className="sk-hint-val">{h.text}</div>}
        </>
      ) : <div className="sk-hint-idle">---</div>}
    </div>
  );
}

// ------------------------------------------------------------------ strings and dampers (DampingPaintBox)
/** The damper's bell on a string: `dir` 1 hangs below the string (String 1), -1 stands above it (String 2). */
function damper(a: number, sharp: number, offset: number, y: number, dir: 1 | -1) {
  const cx = 34 + offset * 134; // along the string: the offset moves the damper towards the far node
  const hw = 7 + (1 - sharp) * 34; // sharper damping acts over a shorter stretch
  const ht = a * 21; // the amount sets how far the damper presses in
  const yy = y + dir * ht;
  const d = `M${cx - hw} ${y}C${cx - hw * 0.45} ${y} ${cx - hw * 0.5} ${yy} ${cx} ${yy}S${cx + hw * 0.45} ${y} ${cx + hw} ${y}Z`;
  return { d, cx, yy, ht };
}

const useNorm = (k: string): number => {
  const v = useParam(k).value / 256;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
};

/** The strings and their dampers: the bells follow the damp amount / sharpness / offset knobs of each string. */
export function StringArt() {
  const d1 = damper(useNorm('string1DampAmount'), useNorm('string1DampSharpness'), useNorm('string1DampOffset'), 15, 1);
  const d2 = damper(useNorm('string2DampAmount'), useNorm('string2DampSharpness'), useNorm('string2DampOffset'), 84, -1);
  const bell = (d: ReturnType<typeof damper>, y: number, up: boolean) => d.ht > 0.4 && (
    <g>
      <path d={d.d} fill={up ? 'url(#skDamperUp)' : 'url(#skDamper)'} stroke="rgba(120,60,10,0.7)" strokeWidth={0.8} />
      <line x1={d.cx} y1={y} x2={d.cx} y2={d.yy} stroke="rgba(110,55,10,0.8)" strokeWidth={0.8} />
      <circle cx={d.cx} cy={d.yy} r={1.8} fill="#ffe2b0" stroke="rgba(110,55,10,0.8)" strokeWidth={0.6} />
    </g>
  );
  const string = (y: number) => (
    <g>
      <line x1={16} y1={y} x2={186} y2={y} stroke="#9d8858" strokeWidth={2.4} strokeLinecap="round" />
      <line x1={16} y1={y - 0.7} x2={186} y2={y - 0.7} stroke="#ecdcae" strokeWidth={0.8} strokeLinecap="round" />
    </g>
  );
  const anchors = (y: number) => [13, 189].map((x) => (
    <g key={x}>
      <circle cx={x} cy={y} r={6.5} fill="url(#skAnchor)" stroke="#a3a4ab" strokeWidth={1.2} />
      <circle cx={x - 1.5} cy={y - 1.8} r={1.6} fill="rgba(255,255,255,0.35)" />
    </g>
  ));
  const coil = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x - 7} y={y - 6} width={14} height={12} rx={2.5} fill="url(#skCoil)" stroke="#5c2c0c" strokeWidth={0.8} />
      <line x1={x - 6} y1={y - 2} x2={x + 6} y2={y - 2} stroke="rgba(70,30,6,0.55)" strokeWidth={0.7} />
      <line x1={x - 6} y1={y + 2} x2={x + 6} y2={y + 2} stroke="rgba(70,30,6,0.55)" strokeWidth={0.7} />
    </g>
  );
  return (
    <svg className="sk-art" style={{ left: STRING_BOX.x, top: STRING_BOX.y }} width={STRING_BOX.w} height={STRING_BOX.h}
      viewBox={`0 0 ${STRING_BOX.w} ${STRING_BOX.h}`} aria-hidden="true">
      <defs><clipPath id="skStringClip"><rect x={14} y={0} width={174} height={99} /></clipPath></defs>
      <rect x={2} y={2} width={196} height={95} rx={4} fill="url(#skPlate)" stroke="rgba(0,0,0,0.4)" />
      <rect x={3} y={3} width={194} height={1} fill="rgba(255,255,255,0.28)" />
      <path d="M88 2H114L108 9H94Z" fill="#f2f3f6" stroke="rgba(0,0,0,0.25)" />
      <path d="M97 3.4L103 3.4L100 6.6Z" fill="#7b7c84" />
      <path d="M88 97H114L108 90H94Z" fill="#f2f3f6" stroke="rgba(0,0,0,0.25)" />
      <path d="M97 95.6L103 95.6L100 92.4Z" fill="#7b7c84" />
      <g clipPath="url(#skStringClip)">
        {bell(d1, 15, false)}
        {bell(d2, 84, true)}
      </g>
      {string(15)}
      {string(84)}
      {anchors(15)}
      {anchors(84)}
      {coil(13, 29)}{coil(189, 29)}{coil(13, 67)}{coil(189, 67)}
      <rect x={4} y={38} width={25} height={30} rx={3} fill="url(#skBridge)" stroke="rgba(0,0,0,0.32)" />
      <line x1={7} y1={53} x2={26} y2={53} stroke="rgba(70,70,80,0.45)" />
    </svg>
  );
}
