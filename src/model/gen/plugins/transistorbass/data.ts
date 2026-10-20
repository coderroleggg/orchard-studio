// Transistor Bass shared data: parameter keys and ranges in FL's order, the
// state shape (FL's 128 programs / patches / sequences, kept sparse), defaults
// and helpers used by the definition, the engine and the editor.

/** Parameter keys in FL's parameter order (index = FL parameter = form Tag). */
export const TB_PARAM_KEYS = [
  'tuning', 'wave', 'cutoff', 'keyFollow', 'reso', 'envMod', 'decay', 'accent', 'volume', 'hp',
  'minDecay', 'pw', 'lfoRate', 'lfoAmt', 'revOn', 'revLowCut', 'revHighCut', 'revPredelay', 'revPredelayFb', 'revSize',
  'revDiffusion', 'revDecay', 'revHighDamp', 'revWidth', 'revDry', 'revEr', 'revWet', 'distOn', 'distHp', 'distDrive',
  'distTone', 'distVol', 'delayOn', 'delaySync', 'delayAmount', 'delayTime', 'delayTap', 'delayFeedback', 'delayTone', 'delayStereo',
  'clicks', 'pulse303',
] as const;

export type TbParamKey = (typeof TB_PARAM_KEYS)[number];

/** Control ranges (all start at 0). */
export const TB_PARAM_MAX: number[] = TB_PARAM_KEYS.map((k) =>
  k === 'tuning' ? 24576 : ['revOn', 'distOn', 'delayOn', 'delaySync', 'pulse303'].includes(k) ? 1 : 65536);

/** FL's displayed defaults (the form's DefaultValue / the plugin's parameter list). */
export const TB_FORM_DEFAULTS = [
  12288, 0, 32768, 32768, 32768, 32768, 32768, 32768, 32768, 32768,
  32768, 6554, 32768, 0, 0, 0, 65536, 16384, 0, 32768,
  32768, 16384, 65536, 65536, 49152, 49152, 32768, 0, 32768, 32768,
  65536, 32768, 0, 1, 0, 32768, 32768, 32768, 32768, 32768,
  6554, 0,
];

/** Synced delay times in whole notes (FL's table; index 7 is FL's "1/3"). */
export const TB_SYNC_TABLE = [
  0.015625, 0.03125, 0.041666666666666664, 0.046875, 0.0625, 0.08333333333333333, 0.09375, 0.3333333333333333,
  0.125, 0.16666666666666666, 0.1875, 0.25, 0.3333333333333333, 0.375, 0.5, 0.6666666666666666, 0.75, 1.0,
];
export const TB_SYNC_TEXT = ['1/64', '1/32', '1/24', '3/64', '1/16', '1/12', '3/32', '1/3', '1/8', '1/6', '3/16', '1/4', '1/3', '3/8', '1/2', '2/3', '3/4', '1/1'];

/** A sequence (FL stores 32 steps; up to 16 play). Flags: 1 gate, 2 slide, 4 accent. */
export interface TbSeqData {
  n: string;
  len: number;
  bpm: number;
  /** Own BPM instead of FL's tempo. */
  ibpm: number;
  /** Shuffle 0..1. */
  sh: number;
  /** Gate length in steps (FL: 0.66 for sequences saved before the Gate knob). */
  gate: number;
  p: number[];
  f: number[];
}

export interface TbPatch { n: string; v: number[] }
export interface TbProgram { patch?: number; seq?: number; transpose?: number }

/** A whole bank as FL saves it (the factory presets). */
export interface TbBank {
  engine: number;
  seqOn: boolean;
  af: boolean;
  prog: number;
  panels: number;
  theme: number;
  /** The current program's edit buffer (the 42 parameters). */
  params: number[];
  /** Patch used for slots without an entry. */
  base: number[];
  patches: Record<string, TbPatch>;
  edits: Record<string, TbPatch>;
  seqs: Record<string, TbSeqData>;
}

/** The plugin state fields beside the 42 parameters. */
export interface TbStateLike extends Record<string, unknown> {
  engine?: number;
  seqOn?: boolean;
  af?: boolean;
  prog?: number;
  progs?: Record<string, TbProgram>;
  base?: number[];
  patches?: Record<string, TbPatch>;
  edits?: Record<string, TbPatch>;
  seqs?: Record<string, TbSeqData>;
  playing?: boolean;
}

export function tbDefaultSeq(): TbSeqData {
  return { n: '', len: 16, bpm: 125, ibpm: 0, sh: 0, gate: 0.66, p: new Array(32).fill(60), f: new Array(32).fill(1) };
}

/** The patch of a slot without an entry. */
export function tbDefaultPatch(base?: number[]): number[] {
  return (base && base.length === 42 ? base : TB_FORM_DEFAULTS).slice();
}

/** Sequence of a program (its own index unless reassigned). */
export function tbProgramSeq(st: TbStateLike, prog: number): number {
  const pr = st.progs?.[String(prog)];
  return pr && typeof pr.seq === 'number' ? pr.seq : prog;
}

/** Patch of a program (its own index unless reassigned). */
export function tbProgramPatchIndex(st: TbStateLike, prog: number): number {
  const pr = st.progs?.[String(prog)];
  return pr && typeof pr.patch === 'number' ? pr.patch : prog;
}

export function tbSeqOf(st: TbStateLike, idx: number): TbSeqData {
  return st.seqs?.[String(idx)] ?? tbDefaultSeq();
}

/** A program's current patch values: its edit buffer, else its stored patch, else the base patch. */
export function tbProgramPatch(st: TbStateLike, prog: number): number[] {
  const pi = tbProgramPatchIndex(st, prog);
  const pa = st.edits?.[String(pi)] ?? st.patches?.[String(pi)];
  const def = tbDefaultPatch(st.base);
  if (!pa || !Array.isArray(pa.v)) return def;
  return def.map((d, i) => (typeof pa.v[i] === 'number' ? pa.v[i] : d));
}

/** FL's number text: rounds half away from zero, never prints "-0". */
export function flFix(x: number, n: number): string {
  const p = Math.pow(10, n);
  let r = (Math.sign(x) * Math.round(Math.abs(x) * p)) / p;
  if (r === 0) r = 0;
  return r.toFixed(n);
}
