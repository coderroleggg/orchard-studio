// MISC tab (Miscellaneous functions): levels adjustment, polyphony, time,
// velocity / keyboard tracking, cut groups, arpeggiator, echo delay and the
// preview keyboard with root note, key zone and fine tuning.

import type { Draft } from 'immer';
import type { Channel } from '../../model/types';
import {
  defaultSampler, slideSteps, gateSteps, adjVolGain,
  type ArpDirection, type ArpSettings, type EchoSettings, type Tracking,
} from '../../model/sampler';
import { formatDb, formatPan } from '../../model/scales';
import { keyName, KEY_MIN, KEY_MAX, DEFAULT_KEY } from '../../model/notes';
import { setHint, clearHint } from '../hint';
import {
  Section, Cell, KnobCell, NumBox, Toggle, Segmented, Choice, editSampler, useViewState, useTimeBase,
  type ChoiceOption, type SamplerRecipe, type SegOption, chAuto } from './controls';
import { pct, signedPct, fmtCents, fmtSteps, fmtStepsTicks, parseKey } from './format';
import { PreviewKeyboard } from './PreviewKeyboard';
import { IconArpDown, IconArpOff, IconArpRandom, IconArpSticky, IconArpUp, IconArpUpDown } from './icons';

const D = defaultSampler();

const ARP_DIRS: SegOption<ArpDirection>[] = [
  { v: 'off', label: <IconArpOff />, hint: 'off' },
  { v: 'up', label: <IconArpUp />, hint: 'up' },
  { v: 'down', label: <IconArpDown />, hint: 'down' },
  { v: 'updown', label: <IconArpUpDown />, hint: 'up and down (bounce)' },
  { v: 'updownSticky', label: <IconArpSticky />, hint: 'up and down (sticky: lowest and highest notes twice)' },
  { v: 'random', label: <IconArpRandom />, hint: 'random' },
];

const ARP_CHORDS: ChoiceOption<ArpSettings['chord']>[] = [
  { v: 'none', label: 'None' },
  { v: 'auto', label: 'Auto' },
  { v: 'autoSustain', label: 'Auto (sustain)' },
];

/** Arpeggiator TIME positions, in steps. */
const ARP_TIMES = [1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 4 / 3, 3 / 2, 2, 3, 4, 6, 8, 12, 16];

function nearestIndex(list: number[], v: number): number {
  let best = 0;
  for (let i = 1; i < list.length; i++) if (Math.abs(list[i] - v) < Math.abs(list[best] - v)) best = i;
  return best;
}

const gainDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function MiscTab({ ch }: { ch: Channel }) {
  const s = ch.sampler;
  const id = ch.id;
  const ts = useTimeBase();
  const tps = ts.ppq / ts.stepsPerBeat;
  const [trk, setTrk] = useViewState<'vel' | 'key'>(id, 'tracker', 'vel');
  const set = (label: string, r: SamplerRecipe) => editSampler(id, label, r);
  const tr = trk === 'vel' ? s.velTrack : s.keyTrack;
  const trName = trk === 'vel' ? 'Velocity tracking' : 'Key tracking';
  const setTr = (what: string, r: (t: Draft<Tracking>) => void) => set(`${trName} ${what}`, (d) => r(trk === 'vel' ? d.velTrack : d.keyTrack));
  const setArp = (what: string, r: (a: Draft<ArpSettings>) => void) => set(`Arpeggiator ${what}`, (d) => r(d.arp));
  const setEcho = (what: string, r: (e: Draft<EchoSettings>) => void) => set(`Echo ${what}`, (d) => r(d.echo));
  const arpTimeIdx = nearestIndex(ARP_TIMES, s.arp.time);
  const cutText = (v: number) => (v === 0 ? '--' : String(v));
  const cutHint = (v: number) => (v === 0 ? 'none' : `group ${v}`);

  return (
    <div className="cs-page">
      <div className="cs-row">
        <Section title="Levels adjustment">
          <KnobCell cap="PAN" label="Pan adjustment" auto={chAuto(id, 'sampler.adjPan')} value={s.adjPan} min={-1} max={1} bipolar def={D.adjPan} format={formatPan}
            set={(v) => set('Levels pan', (d) => { d.adjPan = v; })} />
          <KnobCell cap="VOL" label="Volume adjustment" auto={chAuto(id, 'sampler.adjVol')} value={s.adjVol} def={D.adjVol}
            format={(v) => `${Math.round(v * 200)}% (${formatDb(gainDb(adjVolGain(v)))})`}
            set={(v) => set('Levels volume', (d) => { d.adjVol = v; })} />
          <KnobCell cap="MOD X" label="Mod X adjustment" auto={chAuto(id, 'sampler.adjModX')} value={s.adjModX} min={-1} max={1} bipolar def={D.adjModX} format={signedPct}
            set={(v) => set('Levels mod X', (d) => { d.adjModX = v; })} />
          <KnobCell cap="MOD Y" label="Mod Y adjustment" auto={chAuto(id, 'sampler.adjModY')} value={s.adjModY} min={-1} max={1} bipolar def={D.adjModY} format={signedPct}
            set={(v) => set('Levels mod Y', (d) => { d.adjModY = v; })} />
        </Section>
        <Section title="Polyphony">
          <Cell cap="MAX">
            <NumBox value={s.polyMax} min={0} max={128} def={D.polyMax} name="Polyphony" undo="Max polyphony" width={34}
              display={(v) => (v === 0 ? '---' : String(v))} hintValue={(v) => (v === 0 ? 'unlimited' : plural(v, 'voice'))}
              set={(v) => set('Max polyphony', (d) => { d.polyMax = v; })} />
          </Cell>
          <div className="cs-col">
            <Toggle on={s.mono} label="Mono" name="Mono" set={(v) => set('Mono', (d) => { d.mono = v; })} />
            <Toggle on={s.porta} label="Porta" name="Portamento" set={(v) => set('Portamento', (d) => { d.porta = v; })} />
          </div>
          <KnobCell cap="SLIDE" label="Slide" auto={chAuto(id, 'sampler.slide')} value={s.slide} def={D.slide} format={(v) => fmtStepsTicks(slideSteps(v), ts)}
            set={(v) => set('Slide time', (d) => { d.slide = v; })} />
        </Section>
        <Section title="Time">
          <KnobCell cap="GATE" label="Gate" auto={chAuto(id, 'sampler.gate')} value={s.gate} def={D.gate}
            format={(v) => { const g = gateSteps(v); return g === Infinity ? 'off' : fmtStepsTicks(g, ts); }}
            set={(v) => set('Gate', (d) => { d.gate = v; })} />
          <KnobCell cap="SHIFT" label="Shift" auto={chAuto(id, 'sampler.shift')} value={s.shift} def={D.shift} format={(v) => fmtStepsTicks(v, ts)}
            set={(v) => set('Time shift', (d) => { d.shift = v; })} />
          <KnobCell cap="SWING" label="Swing mix" auto={chAuto(id, 'sampler.swingMix')} value={s.swingMix} def={D.swingMix} format={pct}
            set={(v) => set('Swing mix', (d) => { d.swingMix = v; })} />
          <Toggle on={s.fullPorta} label="Full porta" name="Full porta" set={(v) => set('Full porta', (d) => { d.fullPorta = v; })} />
        </Section>
      </div>

      <div className="cs-row">
        <Section title="Velocity / keyboard tracking">
          <Segmented vertical value={trk} name="Tracking" set={setTrk} options={[
            { v: 'vel', label: 'VEL', hint: 'velocity (edit the velocity tracker)' },
            { v: 'key', label: 'KEY', hint: 'keyboard (edit the key tracker)' },
          ]} />
          <KnobCell key={trk + 'mid'} cap="MID" label={`${trName} mid`} value={tr.mid} min={0} max={trk === 'vel' ? 128 : KEY_MAX} step={1}
            def={trk === 'vel' ? D.velTrack.mid : D.keyTrack.mid}
            format={trk === 'vel' ? (v) => `velocity ${Math.round(v)} (${Math.round((v / 128) * 100)}%)` : (v) => keyName(Math.round(v))}
            set={(v) => setTr('mid', (t) => { t.mid = Math.round(v); })} />
          <KnobCell cap="PAN" label={`${trName} pan`} auto={chAuto(id, `sampler.${trk}Track.pan`)} value={tr.pan} min={-1} max={1} bipolar def={0} format={signedPct}
            set={(v) => setTr('pan', (t) => { t.pan = v; })} />
          <KnobCell cap="MOD X" label={`${trName} mod X`} auto={chAuto(id, `sampler.${trk}Track.modX`)} value={tr.modX} min={-1} max={1} bipolar def={0} format={signedPct}
            set={(v) => setTr('mod X', (t) => { t.modX = v; })} />
          <KnobCell cap="MOD Y" label={`${trName} mod Y`} auto={chAuto(id, `sampler.${trk}Track.modY`)} value={tr.modY} min={-1} max={1} bipolar def={0} format={signedPct}
            set={(v) => setTr('mod Y', (t) => { t.modY = v; })} />
        </Section>
        <Section title="Cut groups">
          <Cell cap="CUT">
            <NumBox value={s.cutGroup} min={0} max={99} def={0} name="Cut" undo="Cut group" width={30} display={cutText} hintValue={cutHint}
              menu={() => [{
                label: 'Cut itself', onClick: () => set('Cut itself', (d) => { const g = d.cutGroup || d.cutBy || 1; d.cutGroup = g; d.cutBy = g; }),
              }]}
              set={(v) => set('Cut group', (d) => { d.cutGroup = v; })} />
          </Cell>
          <Cell cap="CUT BY">
            <NumBox value={s.cutBy} min={0} max={99} def={0} name="Cut by" undo="Cut by group" width={30} display={cutText} hintValue={cutHint}
              set={(v) => set('Cut by group', (d) => { d.cutBy = v; })} />
          </Cell>
        </Section>
      </div>

      <Section title="Arpeggiator">
        <Cell cap="DIRECTION">
          <Segmented value={s.arp.direction} options={ARP_DIRS} name="Arpeggiator direction" set={(v) => setArp('direction', (a) => { a.direction = v; })} />
        </Cell>
        <KnobCell cap="TIME" label="Arpeggiator time" value={arpTimeIdx} min={0} max={ARP_TIMES.length - 1} step={1}
          def={nearestIndex(ARP_TIMES, D.arp.time)} format={(i) => fmtSteps(ARP_TIMES[Math.round(i)], ts)}
          set={(i) => setArp('time', (a) => { a.time = ARP_TIMES[Math.round(i)]; })} />
        <KnobCell cap="GATE" label="Arpeggiator gate" auto={chAuto(id, 'sampler.arp.gate')} value={s.arp.gate} def={D.arp.gate} format={pct}
          set={(v) => setArp('gate', (a) => { a.gate = v; })} />
        <KnobCell cap="RANGE" label="Arpeggiator range" auto={chAuto(id, 'sampler.arp.range')} value={s.arp.range} min={1} max={8} step={1} def={D.arp.range}
          format={(v) => plural(Math.round(v), 'octave')} set={(v) => setArp('range', (a) => { a.range = Math.round(v); })} />
        <KnobCell cap="REPEAT" label="Arpeggiator repeat" auto={chAuto(id, 'sampler.arp.repeat')} value={s.arp.repeat} min={1} max={16} step={1} def={D.arp.repeat}
          format={(v) => plural(Math.round(v), 'time')} set={(v) => setArp('repeat', (a) => { a.repeat = Math.round(v); })} />
        <Cell cap="CHORD">
          <Choice value={s.arp.chord} options={ARP_CHORDS} name="Arpeggiator chord" width={92} onSelect={(v) => setArp('chord', (a) => { a.chord = v; })} />
        </Cell>
        <Toggle on={s.arp.slide} label="Slide" name="Arpeggiator slide" set={(v) => setArp('slide', (a) => { a.slide = v; })} />
      </Section>

      <Section title="Echo delay / fat mode">
        <KnobCell cap="FEED" label="Echo feedback" auto={chAuto(id, 'sampler.echo.feed')} value={s.echo.feed} def={D.echo.feed}
          format={(v) => (v <= 0 ? 'off' : `${Math.round(v * 200)}%`)} set={(v) => setEcho('feedback', (e) => { e.feed = v; })} />
        <KnobCell cap="PAN" label="Echo pan" auto={chAuto(id, 'sampler.echo.pan')} value={s.echo.pan} min={-1} max={1} bipolar def={D.echo.pan}
          format={(v) => `${formatPan(v)} per echo`} set={(v) => setEcho('pan', (e) => { e.pan = v; })} />
        <KnobCell cap="CUT" label="Echo cutoff" auto={chAuto(id, 'sampler.echo.cut')} value={s.echo.cut} min={-1} max={1} bipolar def={D.echo.cut}
          format={(v) => `${signedPct(v)} per echo`} set={(v) => setEcho('cutoff', (e) => { e.cut = v; })} />
        <KnobCell cap="RES" label="Echo resonance" auto={chAuto(id, 'sampler.echo.res')} value={s.echo.res} min={-1} max={1} bipolar def={D.echo.res}
          format={(v) => `${signedPct(v)} per echo`} set={(v) => setEcho('resonance', (e) => { e.res = v; })} />
        <KnobCell cap="PITCH" label="Echo pitch" auto={chAuto(id, 'sampler.echo.pitch')} value={s.echo.pitch} min={-1200} max={1200} bipolar def={D.echo.pitch}
          format={(v) => `${fmtCents(v)} per echo`} set={(v) => setEcho('pitch', (e) => { e.pitch = Math.round(v); })} />
        <KnobCell cap="TIME" label="Echo time" auto={chAuto(id, 'sampler.echo.time')} value={s.echo.time} min={0} max={8} def={D.echo.time}
          format={(v) => fmtStepsTicks(v, ts)} set={(v) => setEcho('time', (e) => { e.time = Math.round(v * tps) / tps; })} />
        <KnobCell cap="# ECH" label="Echoes" auto={chAuto(id, 'sampler.echo.count')} value={s.echo.count} min={1} max={10} step={1} def={D.echo.count}
          format={(v) => String(Math.round(v))} set={(v) => setEcho('count', (e) => { e.count = Math.round(v); })} />
        <div className="cs-col cs-push">
          <Toggle on={s.echo.pingPong} label="Ping pong" name="Echo ping pong" set={(v) => setEcho('ping pong', (e) => { e.pingPong = v; })} />
          <Toggle on={s.echo.fat} label="Fat mode" name="Fat mode" set={(v) => setEcho('fat mode', (e) => { e.fat = v; })} />
        </div>
      </Section>

      <Section title="Keyboard" className="col" tools={
        <button className="cs-txtbtn"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            set('Reset keyboard', (d) => { d.rootKey = DEFAULT_KEY; d.keyLo = KEY_MIN; d.keyHi = KEY_MAX; });
          }}
          onPointerEnter={() => setHint('Reset: root note back to C5 and the key zone removed')} onPointerLeave={clearHint}>
          RESET
        </button>
      }>
        <div className="cs-kb-ctl">
          <Cell cap="ROOT">
            <NumBox value={s.rootKey} min={KEY_MIN} max={KEY_MAX} def={DEFAULT_KEY} name="Root note" undo="Root note" width={38}
              display={keyName} parse={parseKey} set={(v) => set('Root note', (d) => { d.rootKey = v; })} />
          </Cell>
          <Cell cap="ZONE LO">
            <NumBox value={s.keyLo} min={KEY_MIN} max={KEY_MAX} def={KEY_MIN} name="Key zone low" undo="Key zone" width={38}
              display={keyName} parse={parseKey} set={(v) => set('Key zone', (d) => { d.keyLo = Math.min(v, d.keyHi); })} />
          </Cell>
          <Cell cap="ZONE HI">
            <NumBox value={s.keyHi} min={KEY_MIN} max={KEY_MAX} def={KEY_MAX} name="Key zone high" undo="Key zone" width={38}
              display={keyName} parse={parseKey} set={(v) => set('Key zone', (d) => { d.keyHi = Math.max(v, d.keyLo); })} />
          </Cell>
          <KnobCell cap="FINE" label="Fine tune" auto={chAuto(id, 'sampler.fineTune')} value={s.fineTune} min={-100} max={100} bipolar def={D.fineTune} format={fmtCents}
            set={(v) => set('Fine tune', (d) => { d.fineTune = Math.round(v); })} />
          <div className="cs-col">
            <Toggle on={s.mainPitch} label="Main pitch" name="Enable main pitch" set={(v) => set('Main pitch', (d) => { d.mainPitch = v; })} />
            <Toggle on={s.addToKey} label="Add to key" name="Add to key" set={(v) => set('Add to key', (d) => { d.addToKey = v; })} />
          </div>
          <div className="cs-note cs-push">Right-click a key: root note<br />Drag the ruler: key zone</div>
        </div>
        <PreviewKeyboard ch={ch} />
      </Section>
    </div>
  );
}
