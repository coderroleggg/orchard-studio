// Morphine's three page kinds at FL's control positions (layout.ts): a
// generator page (breakpoint spectrum, spectrum timeline, keyboard zones,
// control range, PWM filter), the morphing page (morph square with the four
// generators' mix / pan / mute / solo, morph path lanes, the noise layer) and
// the modulation page (12-slot matrix, the four envelopes).

import { useRef } from 'react';
import { Display, useFxEditor, useParam } from '../../kit';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { MOR_KEYS } from '../../../../model/gen/plugins/morphine/params';
import { NP, selectZone, substituteSpectrum, type MBp, type MEnv, type MGen, type MZone } from '../../../../model/gen/plugins/morphine/state';
import * as L from './layout';
import { MButton, MFader, MMenu, MRing, MTabs, MValue } from './widgets';
import { EnvView, MorphLane, MorphPad, SpectrumView, TimelineView, ZoneView } from './views';
import { currentOf, curvesOf, editState, editZone, envsOf, modOf, morphOf, setView, spectrumOf, usePoolVersion, viewOf } from './data';

const key = (i: number) => MOR_KEYS[i];

/** A small ring knob bound to FL parameter i. */
export function Ring({ i, x, y, size = 22 }: { i: number; x: number; y: number; size?: number }) {
  const p = useParam(key(i));
  return <MRing x={x} y={y} size={size} control={p.control} bipolar={p.def.bipolar} />;
}

/** A pill button bound to boolean FL parameter i. */
export function ParamButton({ i, box, text, color }: { i: number; box: readonly number[]; text: string; color?: string }) {
  const p = useParam(key(i));
  const on = p.value > 0;
  return <MButton x={box[0]} y={box[1]} w={box[2]} h={box[3]} on={on} text={text} hint={p.def.name} color={color}
    onClick={() => { p.control.onBegin?.(); p.set(on ? 0 : 256); p.control.onEnd?.(); }} />;
}

function Fader({ i, x, y, h }: { i: number; x: number; y: number; h: number }) {
  const p = useParam(key(i));
  return <MFader x={x} y={y} h={h} control={p.control} bipolar={p.def.bipolar} />;
}

const loopItems = (cur: number, names: string[], pick: (i: number) => void): MenuItem[] =>
  names.map((n, i) => ({ label: n, radio: true, checked: i === cur, onClick: () => pick(i) }));

let clipBp: MBp | null = null;
let clipZones: MZone[] | null = null;
let clipEnv: MEnv | null = null;

// ------------------------------------------------------------------ generator page

export function GenPage({ g }: { g: number }) {
  const ctx = useFxEditor();
  usePoolVersion();
  const st = ctx.params;
  const view = viewOf(st);
  const cur = currentOf(st, g, view);
  if (!cur) return null;
  const { zone, gen, bi } = cur;
  const bp = zone.bp[bi];
  const [a, p, d] = spectrumOf(st, g, bp);
  const [ca, cb] = curvesOf(st, zone);
  const values = [a, p, d, ca, cb][view.view];
  const G = L.GEN;
  const commitSpectrum = (v: Float32Array) => {
    const arr = Array.from(v, (x) => Math.fround(x));
    if (view.view >= 3) {
      editZone(ctx.slotId, 'Draw curve', g, (z) => {
        const [za, zb] = curvesOf(st, zone);
        z.ca = view.view === 3 ? arr : Array.from(za);
        z.cb = view.view === 4 ? arr : Array.from(zb);
        delete z.cs;
      });
      return;
    }
    editZone(ctx.slotId, 'Draw spectrum', g, (z) => {
      const b = z.bp[bi];
      b.a = view.view === 0 ? arr : Array.from(a);
      b.p = view.view === 1 ? arr : Array.from(p);
      b.d = view.view === 2 ? arr : Array.from(d);
      delete b.s;
    });
  };
  const bpMenu = (): MenuItem[] => [
    { label: 'Import Breakpoint', disabled: true },
    { label: 'Export Breakpoint', disabled: true },
    { separator: true },
    { label: 'Copy Breakpoint', onClick: () => { clipBp = { t: bp.t, l: bp.l, a: Array.from(a), p: Array.from(p), d: Array.from(d) }; } },
    { separator: true },
    { label: 'Paste Breakpoint', disabled: !clipBp, onClick: () => { const c = clipBp; if (c) editZone(ctx.slotId, 'Paste Breakpoint', g, (z) => { const b = z.bp[bi]; b.a = c.a!.slice(); b.p = c.p!.slice(); b.d = c.d!.slice(); delete b.s; }); } },
    { label: 'Paste Current View', disabled: !clipBp, onClick: () => { const c = clipBp; if (c && view.view < 3) commitSpectrum(Float32Array.from([c.a!, c.p!, c.d!][view.view])); } },
    { label: 'Paste Current View to all Breakpoints', disabled: !clipBp || view.view >= 3, onClick: () => {
      const c = clipBp;
      if (!c) return;
      editZone(ctx.slotId, 'Paste Current View to all Breakpoints', g, (z) => {
        z.bp.forEach((b) => {
          const [ba, bpn, bd] = spectrumOf(st, g, b);
          b.a = view.view === 0 ? c.a!.slice() : Array.from(ba);
          b.p = view.view === 1 ? c.p!.slice() : Array.from(bpn);
          b.d = view.view === 2 ? c.d!.slice() : Array.from(bd);
          delete b.s;
        });
      });
    } },
    { separator: true },
    { label: 'Reset Breakpoint', onClick: () => editZone(ctx.slotId, 'Reset Breakpoint', g, (z) => { const b = z.bp[bi]; b.a = new Array(NP).fill(0); b.p = new Array(NP).fill(0); b.d = new Array(NP).fill(0); delete b.s; }) },
    { label: 'Reset Current View', onClick: () => commitSpectrum(new Float32Array(NP).fill(view.view >= 3 ? 1 : 0)) },
  ];
  const tlMenu = (): MenuItem[] => [
    { label: 'Import Spectrum', disabled: true },
    { label: 'Export Spectrum', disabled: true },
    { separator: true },
    { label: 'Reset Spectrum', onClick: () => editZone(ctx.slotId, 'Reset Spectrum', g, (z) => { z.bp = [{ t: 100, l: 1, a: Array.from(substituteSpectrum(g, 64)) }]; z.ls = 100; z.le = 110; }) },
    { label: 'Reset Velocity', onClick: () => editZone(ctx.slotId, 'Reset Velocity', g, (z) => { z.ca = 1; if (z.cs !== undefined) { z.cb = Array.from(cb); delete z.cs; } }) },
    { label: 'Reset Window', onClick: () => editZone(ctx.slotId, 'Reset Window', g, (z) => { z.cb = 1; if (z.cs !== undefined) { z.ca = Array.from(ca); delete z.cs; } }) },
    { separator: true },
    { label: 'Normalize Level', onClick: () => editZone(ctx.slotId, 'Normalize Level', g, (z) => { const m = Math.max(...z.bp.map((b) => b.l)); if (m > 0) z.bp.forEach((b) => { b.l = Math.fround(b.l / m); }); }) },
    { separator: true },
    ...(['before', 'within', 'after'] as const).map((w): MenuItem => ({
      label: `Delete Breakpoints ${w} loop`,
      onClick: () => editZone(ctx.slotId, `Delete Breakpoints ${w} loop`, g, (z) => {
        let t = 0;
        const keep = z.bp.filter((b) => { const s = t; t += b.t; return w === 'before' ? s >= z.ls : w === 'within' ? s < z.ls || s > z.le : s <= z.le; });
        if (keep.length) z.bp = keep;
      }),
    })),
  ];
  const zoneMenu = (): MenuItem[] => [
    { label: 'Import Kbd Zone Layout', disabled: true },
    { label: 'Export Kbd Zone Layout', disabled: true },
    { separator: true },
    { label: 'Copy', onClick: () => { clipZones = structuredClone(gen.zones); } },
    { label: 'Paste', disabled: !clipZones, onClick: () => { const c = clipZones; if (c) editState(ctx.slotId, 'Paste zones', (s) => { (s.gens as MGen[])[g].zones = structuredClone(c); (s.gens as MGen[])[g].cz = 0; }); } },
    { separator: true },
    { label: 'Reset', onClick: () => editState(ctx.slotId, 'Reset zones', (s) => { const gg = (s.gens as MGen[])[g]; gg.zones = [{ ...structuredClone(zone), w: 128, l: 1 }]; gg.cz = 0; }) },
  ];
  return (
    <>
      <MMenu x={G.bpMenu[0]} y={G.bpMenu[1]} w={G.bpMenu[2]} h={G.bpMenu[3]} text="BREAKPOINT" hint="Breakpoint" items={bpMenu} />
      <MValue x={G.bpInfo[0]} y={G.bpInfo[1]} w={G.bpInfo[2]} h={G.bpInfo[3]} text={`${bi + 1} / ${zone.bp.length}   t ${bp.t}   ${(bp.l * 100).toFixed(0)}%`} hint="Breakpoint (number, duration, level)" />
      <MMenu x={G.tool[0] - 28} y={G.tool[1]} w={64} h={G.tool[3]} text="TOOL" hint={`Drawing tool: ${L.TOOLS[view.tool]}`}
        items={() => L.TOOLS.map((t, i) => ({ label: t, radio: true, checked: i === view.tool, onClick: () => setView(ctx.slotId, { tool: i }) }))} />
      <MTabs x={G.views[0]} y={G.views[1]} w={G.views[2]} h={G.views[3]} options={L.PARTIAL_VIEWS} value={view.view} hint="Partial view" onPick={(i) => setView(ctx.slotId, { view: i })} />
      <SpectrumView box={[G.spectrum[0], G.spectrum[1], G.spectrum[2], G.spectrum[3]]} values={values} view={view.view} tool={view.tool} hint={L.PARTIAL_VIEWS[view.view].toLowerCase()} onCommit={commitSpectrum} />
      <MMenu x={G.tlMenu[0]} y={G.tlMenu[1]} w={G.tlMenu[2]} h={G.tlMenu[3]} text="SPECTRUM" hint="Spectrum" items={tlMenu} />
      <MMenu x={G.loop[0]} y={G.loop[1]} w={G.loop[2]} h={G.loop[3]} text={L.LOOP_MODES[zone.lm]} hint="Timeline loop mode"
        items={() => loopItems(zone.lm, L.LOOP_MODES, (i) => editZone(ctx.slotId, 'Loop mode', g, (z) => { z.lm = i; }))} />
      <ParamButton i={L.genParam(g, 0)} box={G.relLoop} text="RELEASE LOOP" />
      <ParamButton i={L.genParam(g, 1)} box={G.sync} text="TEMPO SYNC" />
      <Ring i={L.genParam(g, 2)} x={G.rate[0]} y={G.rate[1] - 1} />
      <Ring i={L.genParam(g, 4)} x={G.keyTrk[0]} y={G.keyTrk[1] - 1} />
      <Ring i={L.genParam(g, 3)} x={G.velTrk[0]} y={G.velTrk[1] - 1} />
      <TimelineView box={[G.timeline[0], G.timeline[1], G.timeline[2], G.timeline[3]]} zone={zone} sel={bi}
        onSelect={(i) => { const bp2 = view.bp.slice(); bp2[g] = i; setView(ctx.slotId, { bp: bp2 }); }}
        onLevel={(i, l) => editZone(ctx.slotId, 'Breakpoint level', g, (z) => { z.bp[i].l = l; })} />
      <MMenu x={G.zoneMenu[0]} y={G.zoneMenu[1]} w={G.zoneMenu[2]} h={G.zoneMenu[3]} text="KEYBOARD ZONE LAYOUT" hint="Keyboard zone layout" items={zoneMenu} />
      <ZoneView box={[G.zones[0], G.zones[1], G.zones[2], G.zones[3]]} zones={gen.zones} current={cur.zi}
        onSelect={(z) => { const u = selectZone(st, g, z); if (Object.keys(u).length) editState(ctx.slotId, 'Select zone', (s) => { Object.assign(s, u); }); }} />
      <Fader i={L.genParam(g, 8)} x={G.detune[0]} y={G.detune[1]} h={86} />
      <Fader i={L.genParam(g, 9)} x={G.pan[0]} y={G.pan[1]} h={86} />
      <Fader i={L.genParam(g, 6)} x={G.pwmRate[0]} y={G.pwmRate[1]} h={86} />
      <Fader i={L.genParam(g, 7)} x={G.pwmPhase[0]} y={G.pwmPhase[1]} h={86} />
      <ParamButton i={L.genParam(g, 5)} box={G.pwmFree} text="FREE" />
      <MTabs x={G.pwmMode[0]} y={G.pwmMode[1]} w={G.pwmMode[2]} h={G.pwmMode[3]} options={L.PWM_MODES} value={gen.pwm} hint="PWM mode"
        onPick={(i) => editState(ctx.slotId, 'PWM mode', (s) => { (s.gens as MGen[])[g].pwm = i; })} />
    </>
  );
}

// ------------------------------------------------------------------ morphing page

function GenCorner({ g }: { g: number }) {
  const ctx = useFxEditor();
  const morph = morphOf(ctx.params);
  const [mix, mx, my, pan, panX, panY, mute, mux, muy, sx, sy, gx, gy] = L.MORPH_GENS[g];
  return (
    <>
      <Ring i={mix} x={mx} y={my} />
      <Ring i={pan} x={panX} y={panY} />
      <ParamButton i={mute} box={[mux, muy, 28, 15]} text="MUTE" />
      <MButton x={sx} y={sy} w={28} h={15} on={morph.solo === g + 1} text="SOLO" hint={`Solo generator ${'ABCD'[g]}`} color="#7dff5a"
        onClick={() => editState(ctx.slotId, 'Solo', (s) => { const m = s.morph as { solo: number }; m.solo = m.solo === g + 1 ? 0 : g + 1; })} />
      <MMenu x={gx} y={gy} w={104} h={21} text={`GENERATOR ${'ABCD'[g]}`} hint={`Generator ${'ABCD'[g]}`}
        items={() => [
          { label: 'Import Generator', disabled: true },
          { label: 'Export Generator', disabled: true },
          { separator: true },
          { label: 'Reset', onClick: () => editState(ctx.slotId, 'Reset Generator', (s) => { (s.gens as MGen[])[g] = { pwm: 0, cz: 0, zones: [{ w: 128, l: 1, bp: [{ t: 100, l: 1, a: Array.from(substituteSpectrum(g, 64)) }], ls: 100, le: 110, lm: 3, rl: 0, rate: 0.5, kt: 0.5, vt: 0.5, sync: 0, ca: 1, cb: 1 }] }; }) },
        ]} />
    </>
  );
}

export function MorphPage({ onNoise }: { onNoise: () => void }) {
  const ctx = useFxEditor();
  const st = ctx.params;
  const morph = morphOf(st);
  const M = L.MORPH;
  const noiseName = typeof st.noise === 'string' && st.noise ? st.noise.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') : '(none)';
  const missing = typeof st.noise === 'string' && st.noise && !st.noiseSample;
  return (
    <>
      {[0, 1, 2, 3].map((g) => <GenCorner key={g} g={g} />)}
      <MorphPad box={[M.xy[0], M.xy[1], M.xy[2], M.xy[3]]} morph={morph}
        onMove={(i, xv, yv) => editState(ctx.slotId, 'Morph point', (s) => { const m = s.morph as { pts: [number, number, number][] }; m.pts[i][0] = xv; m.pts[i][1] = yv; })} />
      <MMenu x={M.pathMenu[0]} y={M.pathMenu[1]} w={M.pathMenu[2]} h={M.pathMenu[3]} text="MORPH PATH" hint="Morph path"
        items={() => [
          { label: 'Import Morph Path', disabled: true },
          { label: 'Export Morph Path', disabled: true },
          { separator: true },
          { label: 'Reset', onClick: () => editState(ctx.slotId, 'Reset Morph Path', (s) => { s.morph = { pts: [[0, 1, 100]], ls: 100, le: 110, lm: 0, solo: (s.morph as { solo: number }).solo }; }) },
        ]} />
      <MValue x={M.pathName[0]} y={M.pathName[1]} w={M.pathName[2]} h={M.pathName[3]} text={`${morph.pts.length} point${morph.pts.length > 1 ? 's' : ''}`} hint="Morph path" />
      <MorphLane box={[M.laneX[0], M.laneX[1], M.laneX[2], M.laneX[3]]} morph={morph} axis={1} label="X  (A - B)" />
      <MorphLane box={[M.laneY[0], M.laneY[1], M.laneY[2], M.laneY[3]]} morph={morph} axis={0} label="Y  (D - A)" />
      <MMenu x={M.loop[0]} y={M.loop[1]} w={M.loop[2]} h={M.loop[3]} text={L.LOOP_MODES[morph.lm]} hint="Morph loop mode"
        items={() => loopItems(morph.lm, L.LOOP_MODES, (i) => editState(ctx.slotId, 'Morph loop mode', (s) => { (s.morph as { lm: number }).lm = i; }))} />
      <ParamButton i={83} box={M.sync} text="TMP SYNC" />
      <Ring i={84} x={M.rate[0]} y={M.rate[1] - 1} />
      <Ring i={85} x={M.keyTrk[0]} y={M.keyTrk[1] - 1} />
      <Ring i={86} x={M.velTrk[0]} y={M.velTrk[1] - 1} />
      <MValue x={M.noiseName[0]} y={M.noiseName[1]} w={M.noiseName[2]} h={M.noiseName[3]} text={missing ? `${noiseName} (missing)` : noiseName}
        hint={missing ? 'Noise sample: FL content, click to import it from your FL installation' : 'Noise sample'} onPointerDown={missing ? () => onNoise() : undefined} />
      <ParamButton i={36} box={M.bypass} text="BYPASS" />
      <ParamButton i={37} box={M.mono} text="MONO" />
      <MMenu x={M.noiseLoop[0]} y={M.noiseLoop[1]} w={M.noiseLoop[2]} h={M.noiseLoop[3]} text={L.NOISE_LOOPS[Number(st.nzLoop) || 0]} hint="Noise loop mode" arrow={false}
        items={() => loopItems(Number(st.nzLoop) || 0, L.NOISE_LOOPS, (i) => editState(ctx.slotId, 'Noise loop mode', (s) => { s.nzLoop = i; }))} />
      <MMenu x={M.noiseFlt[0]} y={M.noiseFlt[1]} w={M.noiseFlt[2]} h={M.noiseFlt[3]} text={L.NOISE_FILTERS[Number(st.nzFlt) || 0]} hint="Noise filter mode" arrow={false}
        items={() => loopItems(Number(st.nzFlt) || 0, L.NOISE_FILTERS, (i) => editState(ctx.slotId, 'Noise filter mode', (s) => { s.nzFlt = i; }))} />
      {L.NOISE_KNOBS.map(([i, x, y]) => <Ring key={i} i={i} x={x + 4} y={y + 4} size={30} />)}
    </>
  );
}

// ------------------------------------------------------------------ modulation page

function MatrixRow({ r }: { r: number }) {
  const ctx = useFxEditor();
  const mod = modOf(ctx.params);
  const M = L.MOD;
  const dx = r >= 6 ? M.right : 0;
  const y = M.rowY + M.rowH * (r % 6);
  const drag = useRef<{ y0: number; a0: number } | null>(null);
  const setMod = (label: string, fn: (m: { src: number[]; dst: number[]; amt: number[] }) => void, merge?: string) => editState(ctx.slotId, label, (s) => { fn(s.mod as { src: number[]; dst: number[]; amt: number[] }); }, merge);
  const amt = mod.amt[r];
  return (
    <>
      <MValue x={M.src[0] + dx} y={y} w={M.src[1]} h={19} text={L.MOD_SOURCES[mod.src[r]] ?? '---'} hint={`Slot ${r + 1} source`}
        onPointerDown={(e) => {
          const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const base = L.MOD_SOURCES.slice(0, 9).map((n, i): MenuItem => ({ label: n, radio: true, checked: mod.src[r] === i, onClick: () => setMod('Modulation source', (m) => { m.src[r] = i; }) }));
          const ccs: MenuItem = { label: 'MIDI CC', submenu: Array.from({ length: 128 }, (_, k): MenuItem => ({ label: `CC ${k}`, radio: true, checked: mod.src[r] === 9 + k, onClick: () => setMod('Modulation source', (m) => { m.src[r] = 9 + k; }) })) };
          openMenu(rc.left, rc.bottom, [...base, ccs]);
        }} />
      <Display x={M.amt[0] - 11 + dx} y={y - 1} w={22} h={21} deps={[amt]}
        draw={(g) => {
          g.clearRect(0, 0, 22, 21);
          g.strokeStyle = '#b9bdf0'; g.lineWidth = 2;
          g.beginPath(); g.arc(11, 10.5, 8.5, 0, Math.PI * 2); g.stroke();
          const v = amt * 2 - 1;
          if (Math.abs(v) > 0.004) {
            g.strokeStyle = '#ff9d2a'; g.lineWidth = 2.4;
            g.beginPath(); g.arc(11, 10.5, 8.5, -Math.PI / 2, -Math.PI / 2 + v * Math.PI * 0.95, v < 0); g.stroke();
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y0: e.clientY, a0: amt };
        }}
        onPointerMove={(e) => {
          setHint(`Slot ${r + 1} amount: ${Math.round((amt * 2 - 1) * 100)} %`);
          const dr = drag.current;
          if (!dr || !(e.buttons & 1)) return;
          const v = Math.max(0, Math.min(1, dr.a0 + (dr.y0 - e.clientY) / 160));
          setMod('Modulation amount', (m) => { m.amt[r] = Math.fround(v); }, `mamt${r}`);
        }}
        onPointerUp={() => { drag.current = null; clearHint(); }} />
      <MValue x={M.dst[0] + dx} y={y} w={M.dst[1]} h={19} text={L.MOD_TARGETS[mod.dst[r]] ?? '---'} hint={`Slot ${r + 1} destination`}
        onPointerDown={(e) => {
          const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(rc.left, rc.bottom, L.MOD_TARGETS.map((n, i): MenuItem => ({ label: n, radio: true, checked: mod.dst[r] === i, onClick: () => setMod('Modulation destination', (m) => { m.dst[r] = i; }) })));
        }} />
    </>
  );
}

export function ModPage() {
  const ctx = useFxEditor();
  const st = ctx.params;
  const view = viewOf(st);
  const e = view.env;
  const env = envsOf(st)[e];
  const M = L.MOD;
  const bend = useParam(key(3));
  const setEnv = (label: string, fn: (x: MEnv) => void) => editState(ctx.slotId, label, (s) => { fn((s.envs as MEnv[])[e]); });
  if (!env) return null;
  return (
    <>
      <MValue x={M.title[0]} y={M.title[1]} w={M.title[2]} h={M.title[3]} text="MODULATION MATRIX" hint="Modulation matrix" />
      <MValue x={M.bend[0]} y={M.bend[1]} w={M.bend[2]} h={M.bend[3]} text={bend.control.format?.(bend.value) ?? ''} hint={bend.def.name}
        onWheel={(d) => { bend.control.onBegin?.(); bend.set(Math.max(0, Math.min(256, bend.value + d * 256 / 12))); bend.control.onEnd?.(); }} />
      {Array.from({ length: 12 }, (_, r) => <MatrixRow key={r} r={r} />)}
      <MMenu x={M.envMenu[0]} y={M.envMenu[1]} w={M.envMenu[2]} h={M.envMenu[3]} text="ENVELOPE" hint={`Envelope ${e + 1}`}
        items={() => [
          { label: 'Import Envelope', disabled: true },
          { label: 'Export Envelope', disabled: true },
          { separator: true },
          { label: 'Copy', onClick: () => { clipEnv = structuredClone(env); } },
          { label: 'Paste', disabled: !clipEnv, onClick: () => { const c = clipEnv; if (c) setEnv('Paste Envelope', (x) => { x.pts = structuredClone(c.pts); x.ls = c.ls; x.le = c.le; x.lm = c.lm; x.bip = c.bip; }); } },
          { separator: true },
          { label: 'Reset', onClick: () => setEnv('Reset Envelope', (x) => { x.pts = [[1, 100]]; x.ls = 100; x.le = 110; x.lm = 0; x.bip = 0; }) },
        ]} />
      <MMenu x={M.loop[0]} y={M.loop[1]} w={M.loop[2]} h={M.loop[3]} text={L.LOOP_MODES[env.lm]} hint="Envelope loop mode"
        items={() => loopItems(env.lm, L.LOOP_MODES, (i) => setEnv('Envelope loop mode', (x) => { x.lm = i; }))} />
      <ParamButton i={L.envParam(e, 0)} box={M.relLoop} text="RELEASE LOOP" />
      <ParamButton i={L.envParam(e, 1)} box={M.sync} text="TEMPO SYNC" />
      <MButton x={M.bipolar[0]} y={M.bipolar[1]} w={M.bipolar[2]} h={M.bipolar[3]} on={env.bip === 1} text="BIPOLAR" hint="Bipolar envelope"
        onClick={() => setEnv('Bipolar', (x) => { x.bip = x.bip ? 0 : 1; })} />
      <Ring i={L.envParam(e, 2)} x={M.rate[0]} y={M.rate[1] - 1} />
      <Ring i={L.envParam(e, 3)} x={M.keyTrk[0]} y={M.keyTrk[1] - 1} />
      <Ring i={L.envParam(e, 4)} x={M.velTrk[0]} y={M.velTrk[1] - 1} />
      <Ring i={L.envParam(e, 5)} x={M.vel[0]} y={M.vel[1] - 1} />
      <EnvView box={[M.env[0], M.env[1], M.env[2], M.env[3]]} env={env} onLevel={(i, l) => setEnv('Envelope point', (x) => { x.pts[i][0] = l; })} />
      <MTabs x={M.egTabs[0]} y={M.egTabs[1]} w={M.egTabs[2]} h={M.egTabs[3] * 4} options={['EG 1', 'EG 2', 'EG 3', 'EG 4']} value={e} vertical hint="Envelope"
        onPick={(i) => setView(ctx.slotId, { env: i })} />
    </>
  );
}

