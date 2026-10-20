// Multiband Compressor editor (FL: Fruity Multiband Compressor, 800 x 155).
// Left: main meter with its IN / OUT button, the IIR / FIR filter type switch,
// LIMITER and the master GAIN. Then the visual (peaks or band responses) with
// SPEED and the four crossover wheels (L Freq, M Freq L, M Freq H, H Freq; they
// snap together when crossed), and the LOW / MID / HIGH BAND sections: A / M / B
// state, THRES, RATIO, KNEE, ATT, REL, GAIN, the band meter and its C(ompression)
// meter. Every control sits at FL's form coordinates.

import { FxPanel, useFxEditor, useFxView } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { setHint, clearHint } from '../../../hint';
import { mbStateDefaults } from '../../../../model/fx/plugins/mbcompressor';
import { C, Cap, FilterSwitch, FreqWheel, IoButton, LimiterCheck, SpeedSlider, StateSelector, TickWheel, abs } from './widgets';
import { Meters, Visual, useMbFeed, useMbMonitor } from './visual';

const W = 800, H = 155;

/** One band section; `dx` = its offset from the LOW BAND section (FL: +172 per band). */
function Band({ band, dx, title, st, io, onIo, which }: { band: 'l' | 'm' | 'h'; dx: number; title: string; st: ReturnType<typeof useMbMonitor>; io: boolean; onIo: () => void; which: number }) {
  const k = (f: string) => `${band}${f}`;
  const X = (x: number) => x + dx;
  return (
    <>
      <div style={abs({ x: X(283), y: 6, w: band === 'h' ? 133 : 132, h: 17 }, { background: C.bar, color: '#e3e9eb', fontSize: 12.5, lineHeight: '17px', textAlign: 'right', fontStyle: 'italic', fontWeight: 500, paddingRight: 7, whiteSpace: 'nowrap', pointerEvents: 'none', letterSpacing: '0.01em' })}>{title}</div>
      <StateSelector k={k('State')} x={X(285)} y={8} />
      <TickWheel k={k('Thres')} x={X(283)} y={37} />
      <TickWheel k={k('Ratio')} x={X(329)} y={37} />
      <TickWheel k={k('Knee')} x={X(375)} y={37} />
      <TickWheel k={k('Att')} x={X(283)} y={98} />
      <TickWheel k={k('Rel')} x={X(329)} y={98} />
      <TickWheel k={k('Out')} x={X(375)} y={98} red />
      <Cap x={X(285)} y={79} w={36}>THRES</Cap>
      <Cap x={X(333)} y={79} w={32}>RATIO</Cap>
      <Cap x={X(381)} y={79} w={28}>KNEE</Cap>
      <Cap x={X(287)} y={139} w={32}>ATT</Cap>
      <Cap x={X(335)} y={139} w={28}>REL</Cap>
      <Cap x={X(383)} y={139} w={24}>GAIN</Cap>
      <Meters st={st} which={which} x={X(423)} y={6} w={12} cx={X(441)} io={io} />
      <IoButton x={X(420)} y={138} out={io} onToggle={onIo} />
      <Cap x={X(438)} y={139} w={12}>C</Cap>
    </>
  );
}

/** The small band shape glyphs under the crossover wheels (FL's FreqLabelsPaintBox). */
function FreqGlyphs() {
  return (
    <svg style={abs({ x: 82, y: 137, w: 190, h: 10 }, { pointerEvents: 'none', overflow: 'visible' })} viewBox="82 137 190 10">
      <path d="M93 139.5 H104 L108 145.5" stroke={C.low} strokeWidth={1.3} fill="none" />
      <path d="M143 145.5 L147 139.5 H204 L208 145.5" stroke={C.mid} strokeWidth={1.3} fill="none" />
      <path d="M246 145.5 L250 139.5 H260" stroke={C.high} strokeWidth={1.3} fill="none" />
    </svg>
  );
}

function MbEditor() {
  const { params } = useFxEditor();
  const view = useFxView();
  const io = (Array.isArray(params.io) ? params.io : (mbStateDefaults().io as boolean[])).map((b) => b === true);
  const speed = typeof params.speed === 'number' ? params.speed : 50;
  const st = useMbMonitor();
  useMbFeed(st, speed);
  const toggleIo = (i: number) => view('Meter input / output', (p) => {
    const cur = (Array.isArray(p.io) ? p.io : [false, false, false, false]).map((b) => b === true);
    cur[i] = !cur[i];
    p.io = cur;
  });
  const touch = () => { st.touched = performance.now(); };
  return (
    <FxPanel width={W} height={H} style={{ background: C.panel }}>
      {/* main section */}
      <Meters st={st} which={0} x={7} y={6} w={13} io={io[0]} />
      <IoButton x={4} y={137} out={io[0]} onToggle={() => toggleIo(0)} />
      <FilterSwitch x={32} y={6} />
      <LimiterCheck x={24} y={40} />
      <TickWheel k="master" x={27} y={98} />
      <Cap x={35} y={139} w={24}>GAIN</Cap>
      {/* visual */}
      <div style={abs({ x: 76, y: 6, w: 200, h: 142 }, { background: C.bevel, borderRadius: 6 })} />
      <Visual st={st} params={params} speed={speed} />
      <div style={abs({ x: 155, y: 88, w: 30, h: 13 }, { color: C.label, fontSize: 9.5, lineHeight: '13px', pointerEvents: 'none' })}>SPEED</div>
      <SpeedSlider x={186} y={90} w={87} h={9} value={speed} onChange={(v) => view('Visual speed', (p) => { p.speed = Math.round(v); })} />
      <FreqWheel k="lFreq" partner="mFreqL" x={82} y={103} onTouch={touch} />
      <FreqWheel k="mFreqL" partner="lFreq" x={132} y={103} onTouch={touch} />
      <FreqWheel k="mFreqH" partner="hFreq" x={182} y={103} onTouch={touch} />
      <FreqWheel k="hFreq" partner="mFreqH" x={233} y={103} onTouch={touch} />
      <FreqGlyphs />
      <div style={abs({ x: 80, y: 11, w: 192, h: 76 })} onPointerEnter={() => setHint(speed > 0 ? 'Input / output peaks (touch a cut-off knob for the bands)' : 'Band filters')} onPointerLeave={clearHint} />
      {/* bands */}
      <Band band="l" dx={0} title="LOW BAND" st={st} io={io[1]} onIo={() => toggleIo(1)} which={1} />
      <Band band="m" dx={172} title="MID BAND" st={st} io={io[2]} onIo={() => toggleIo(2)} which={2} />
      <Band band="h" dx={344} title="HIGH BAND" st={st} io={io[3]} onIo={() => toggleIo(3)} which={3} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'mbcompressor', Editor: MbEditor };
