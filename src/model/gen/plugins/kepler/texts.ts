// Value-text machinery shared by Kepler and Kepler Exo: FL's Pascal wrappers (Kepler_x64 / Kepler Exo_x64
// GetName(FPN_ParamValue)) turn a control value into a normalised double (v - Min) / (Max - Min) clamped
// to 0..1, compute the displayed number mostly in single precision (Free Pascal `Single` arithmetic,
// `Power` through exp(ln)) and print it with Format('%.nf'). FL's number printing rounds the DOUBLE to 15
// significant digits first and then half away from zero ("0.15" prints "0.2" although the double is
// 0.1499999999999999944): fpcFix(). Everything here was read from the wrappers' disassembly and verified
// against full test-host sweeps (docs/research/gen/kepler.md).

const f32 = Math.fround;

/** Pascal Round: half to even. */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Free Pascal Format('%.nf', [x]): the double is converted to 15 significant decimal digits, which are then
 * rounded half away from zero at n decimals; a result that rounds to zero never prints a minus sign.
 */
export function fpcFix(x: number, n: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Inf' : '-Inf';
  const neg = x < 0;
  const a = Math.abs(x);
  let digits = '000000000000000';
  let e10 = 0;
  if (a !== 0) {
    const m = /^(\d)\.(\d+)e([+-]\d+)$/.exec(a.toExponential(14));
    if (m) { digits = m[1] + m[2]; e10 = parseInt(m[3], 10); }
  }
  // digits d0.d1d2... x 10^e10  ->  integer / fraction digit strings
  let ip: string;
  let fp: string;
  if (e10 >= 0) {
    ip = digits.slice(0, e10 + 1).padEnd(e10 + 1, '0');
    fp = digits.slice(e10 + 1);
  } else {
    ip = '0';
    fp = '0'.repeat(-e10 - 1) + digits;
  }
  let all = ip + fp.slice(0, n).padEnd(n, '0');
  if (fp.length > n && fp.charCodeAt(n) >= 53) { // next digit >= '5': round up
    const d = all.split('');
    let i = d.length - 1;
    while (i >= 0) {
      if (d[i] === '9') { d[i] = '0'; i--; } else { d[i] = String.fromCharCode(d[i].charCodeAt(0) + 1); break; }
    }
    all = (i < 0 ? '1' : '') + d.join('');
  }
  const il = all.length - n;
  const s = n > 0 ? `${all.slice(0, il)}.${all.slice(il)}` : all;
  const zero = !/[1-9]/.test(s);
  return (neg && !zero ? '-' : '') + s;
}

/** FPC intpower (repeated squaring). */
function intPower(base: number, exponent: number): number {
  if (base === 0 && exponent === 0) return 1;
  let i = Math.abs(exponent);
  let r = 1;
  let b = base;
  while (i > 0) {
    while ((i & 1) === 0) { i = Math.floor(i / 2); b = b * b; }
    i -= 1;
    r *= b;
  }
  return exponent < 0 ? 1 / r : r;
}

/** FPC math.power on doubles: integer exponents by squaring, otherwise exp(e * ln(b)). */
export function powD(b: number, e: number): number {
  if (e === 0) return 1;
  if (b === 0 && e > 0) return 0;
  if (Math.abs(e) <= 2147483647 && e === Math.floor(e)) return intPower(b, e);
  return Math.exp(e * Math.log(b));
}

/** FPC power(Single, Single). */
export function powF(b: number, e: number): number {
  if (e === 0) return 1;
  if (b === 0 && e > 0) return 0;
  if (e === Math.floor(e)) return f32(powD(b, e));
  return f32(Math.exp(e * Math.log(b)));
}

/** The control's normalised position: (v - Min) * (1 / (Max - Min)) clamped to 0..1 (double). */
export function norm(v: number, min: number, max: number): number {
  return Math.min(Math.max((v - min) * (1 / (max - min)), 0), 1);
}

/** log2 of the VCF cutoff nodes (Hz: 4, 5.5, 10, 20, 51.4, 124, 373, 1420, 5360, 36700, 50000), single precision. */
export const CUTOFF_LOG2: readonly number[] = [
  2, 2.4594316482543945, 3.321928024291992, 4.321928024291992, 5.683696269989014, 6.954196453094482,
  8.543031692504883, 10.471674919128418, 12.388017654418945, 15.163492202758789, 15.609640121459961,
];

/** Kepler Exo's LFO1 rate curve: log2 of the period in units of 0.046 s (7.44 .. 0), single precision. */
export const LFO1_RATE_LOG2: readonly number[] = [
  7.4422221183776855, 5.807354927062988, 4.349882125854492, 3.6563470363616943, 3.113062620162964,
  2.6711947917938232, 2.0462937355041504, 1.3093280792236328, 0.8514775037765503, 0.28379297256469727, 0,
];

/** Linear interpolation in an 11-node table at x * 10 (single precision, as the wrapper does it). */
export function interp10(tab: readonly number[], x: number): number {
  const s8 = f32(x * 10);
  const i = Math.floor(s8);
  if (i >= 10) return tab[10];
  const fr = f32(s8 - i);
  return f32(f32(tab[i] * f32(1 - fr)) + f32(tab[i + 1] * fr));
}

/** VCF cutoff in Hz of the control position d (0..1). */
export function cutoffHz(d: number): number {
  return f32(powD(2, interp10(CUTOFF_LOG2, f32(Math.min(Math.max(d, 0), 1)))));
}

/** High-pass frequency: 10 + 160 x^2 (single). */
export function hpHz(d: number): number {
  const x = f32(d);
  return f32(10 + f32(f32(x * x) * 160));
}

/** Kepler's LFO / arpeggiator rate with tempo sync off: 10 x^2 Hz (single). */
export function rate10Hz(d: number): number {
  const x = f32(d);
  return f32(f32(x * x) * 10);
}

/** Kepler Exo's LFO2 rate: 0.1 * 10^(4x) Hz. */
export function lfo2Hz(d: number): number {
  const x = f32(d);
  return f32(0.1 * powF(10, f32(x * 4)));
}

/** Kepler Exo's LFO1 rate: 1 / (0.046 * 2^table(x)) Hz. */
export function lfo1Hz(d: number): number {
  return f32(1 / (0.046 * powF(2, interp10(LFO1_RATE_LOG2, f32(d)))));
}

/** Tempo-synced LFO rate in 1/48 beat ticks (shown as "beats:ticks"). */
export function syncTicks(d: number): number {
  let s = f32(f32(1 - f32(d)) * 7);
  const t = (powD(2, s) - 1) * 1.0078740157480315;
  s = f32(t);
  s = f32(s * 48);
  s = f32(s * 6143);
  s = f32(s / 6144);
  return Math.trunc(1.1 + s);
}

/** "beats:ticks" text of a synced LFO rate. */
export function syncRateText(d: number): string {
  const t = syncTicks(d);
  return `${Math.trunc(t / 48)}:${t % 48}`;
}

/** Exponential interpolation lo .. hi at x (EQ / hyper chorus frequencies, single). */
export function expInterp(d: number, lo: number, hi: number): number {
  const x = f32(d);
  const s0 = f32(hi / lo);
  const r = f32(Math.log(s0) / 0.6931471805599453);
  return f32(lo * powF(2, f32(x * r)));
}

/** EQ Q: 0.28 * 13^(x^1.28). */
export function eqQ(d: number): number {
  const p = f32(powD(f32(d), 1.28));
  return f32(0.28 * powF(13, p));
}

/** EQ gain in dB: -16 + 32 x (single). */
export function eqGain(d: number): number {
  return f32(-16 + f32(32 * f32(d)));
}

/** Index of a note-length table entry: trunc(0.5 + x (n - 1)) clamped to 0..n-1. */
export function noteIndex(x: number, n: number): number {
  return Math.min(Math.max(Math.floor(0.5 + x * (n - 1)), 0), n - 1);
}

/** Note lengths of the tempo-synced arpeggiator rate (13 steps). */
export const ARP_SYNC_TEXT: readonly string[] = [
  '1/4', '1/8 Dotted', '1/4 Triplet', '1/8', '1/16 Dotted', '1/8 Triplet', '1/16', '1/32 Dotted', '1/16 Triplet',
  '1/32', '1/64 Dotted', '1/32 Triplet', '1/64',
];

/** Note lengths of the tempo-synced delay time (18 steps; FL's table repeats "1/3"). */
export const DELAY_SYNC_TEXT: readonly string[] = [
  '1/64', '1/32', '1/24', '3/64', '1/16', '1/12', '3/32', '1/3', '1/8', '1/6', '3/16', '1/4', '1/3', '3/8', '1/2',
  '2/3', '3/4', '1/1',
];

/** "x.x%" of a normalised position. */
export function pctText(d: number): string {
  return `${fpcFix(d * 100, 1)}%`;
}

/** Volume wheel text: 20 log10(position) dB, "-Inf dB" at 0. */
export function volumeText(d: number): string {
  return d <= 0 ? '-Inf dB' : `${fpcFix(20 * Math.log10(d), 2)} dB`;
}

/** The control value FL's text function sees: the integer position (Round) inside the control's range. */
export function ctrlValue(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, roundEven(v)));
}
