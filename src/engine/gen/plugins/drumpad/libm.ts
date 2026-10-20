// macOS libm routines and arm64 fused multiply-adds, emulated bit for bit, for
// the Drumpad / Drumaxx engines (FL calls exp10f, sinf / cosf and
// __sincosf_stret from libsystem_m). Copied from the BooBass port
// (src/engine/gen/plugins/boobass/libm.ts, f32.ts: disassembled from
// libsystem_m.dylib, macOS 26 arm64, checked against the real functions).

const f = Math.fround;

/**
 * float32 fused multiply-add a*b + c rounded once (arm64 FMADD Sd, Sn, Sm, Sa
 * with Sn = a, Sm = b, Sa = c) for float32 inputs. The product of two float32
 * values is exact in double; the double sum can only round the wrong way when
 * it lands exactly halfway between two float32 values, which the exact error
 * of the double sum (TwoSum) then resolves.
 */
export function fma32(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const r = f(s);
  const d = s - r;
  if (d === 0) return r;
  const o = f(s + d);
  if (o === r || o - s !== d) return r;
  const bb = s - p;
  const e = (p - (s - bb)) + (c - bb);
  if (e === 0) return r;
  return (e > 0) === (o > r) ? o : r;
}

const SPLIT = 134217729; // 2^27 + 1

/** Double fused multiply-add a*b + c (Dekker's exact product, then the sum), arm64 FMADD Dd. */
export function fmaD(a: number, b: number, c: number): number {
  const p = a * b;
  let t = SPLIT * a;
  const ah = t - (t - a), al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  const s = p + c;
  const bb = s - p;
  const err = (p - (s - bb)) + (c - bb);
  return s + (err + e);
}

// ------------------------------------------------------------------ exp10f
const EXP2_128 = new Float64Array(128);
for (let j = 0; j < 128; j++) EXP2_128[j] = Math.pow(2, j / 128);
const K10 = 425.20679614558236; // 128 log2(10)
const C1 = 0.005415217308896754;
const C2 = 1.4662262378543872e-5;

/** Apple's exp10f: 2^(k/128) from a table times a quadratic in the remainder, in double, rounded to float. */
export function exp10f(x: number): number {
  if (!(Math.abs(x) < 64)) return f(Math.pow(10, x));
  const t = x * K10;
  const a = Math.abs(t);
  let k = Math.floor(a);
  if (a - k >= 0.5) k += 1;
  if (t < 0) k = -k;
  const r = t - k;
  const s = EXP2_128[k & 127] * Math.pow(2, k >> 7);
  const p = fmaD(C2, r, C1) * r;
  return f(fmaD(p, s, s));
}

// ------------------------------------------------------------------ sincosf
const TWO_OVER_PI = 0.6366197723675814;
const A0 = -14.11962047131294, A1 = -8.36721486831633;
const B0 = -15.469930309596, B1 = -14.71749014926;
const SC0 = 0.00015820674370772955, SC1 = 0.0009036317034594685;
const D0 = 40.5713390182018, D1 = 7.367313974172263;
const E0 = 244.7234259671355, E1 = 150.210178361388;

/** Result of sincosf (reused). */
export const sincos = { s: 0, c: 0 };

/** Apple's __sincosf_stret (|x| < 120): sets sincos.s / sincos.c. */
export function sincosf(x: number): void {
  const ax = Math.abs(x);
  if (ax < 2.44140625e-4) {
    sincos.c = f(f(67108864 - ax) * 1.4901161193847656e-8);
    sincos.s = f(fma32(x, 67108864, x) * 1.4901161193847656e-8);
    return;
  }
  if (!(ax < 120)) { sincos.s = f(Math.sin(x)); sincos.c = f(Math.cos(x)); return; }
  const d2 = x * TWO_OVER_PI;
  const fl = Math.floor(d2);
  const fr = d2 - fl;
  const q = fr > 0.5 ? fl + 1 : fr < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1);
  const r = d2 - q;
  const r2 = r * r;
  const v5a = fmaD(r2, r2 + A0, D0), v5b = fmaD(r2, r2 + A1, D1);
  const v6a = fmaD(r2, r2 + B0, E0), v6b = fmaD(r2, r2 + B1, E1);
  let s = f(((r * SC0) * v5a) * v6a);
  let c = f((SC1 * v5b) * v6b);
  const qi = q & 3;
  if (qi & 2) { s = -s; c = -c; }
  if (qi & 1) { sincos.s = c; sincos.c = -s; } else { sincos.s = s; sincos.c = c; }
}

// ------------------------------------------------------------------ sinf / cosf
// Apple's sinf / cosf (separate routines from __sincosf_stret; |x| < 120):
// x - n pi / 2 (one fused step) and a sine or cosine polynomial in double.
const TWO_PI_INV = 0.63661977236758138, HALF_PI = 1.5707963267948966;
const CP0 = 2.4383567311838599e-05, CP1 = -0.0013886681647984319, CP2 = 0.041666620357131375, CP3 = -0.49999999694475988;
const SP0 = -0.00019515283191485737, SP1 = 0.0083321607618555751, SP2 = -0.16666654609548576;
const F_PI4 = 0.785398185253143310546875, F_TINY = 0.000244140625;
const cosPoly = (r: number) => { const d1 = r * r, d2 = d1 * d1; return fmaD(d1, fmaD(d2, fmaD(d1, CP0, CP1), fmaD(d1, CP2, CP3)), 1); };
const sinPoly = (r: number) => { const d4 = r * r, d5 = r * d4; return fmaD(d4 * d5, fmaD(d4, SP0, SP1), fmaD(d5, SP2, r)); };
/** Round to nearest, ties to even (arm64 FRINTN). */
const rintn = (x: number) => { const r = Math.round(x); return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r; };
function sincosQ(x: number, n: number): number {
  const r = fmaD(-rintn(x * TWO_PI_INV), HALF_PI, x);
  const v = n & 1 ? cosPoly(r) : sinPoly(r);
  return f(n & 2 ? -v : v);
}

/** Apple's sinf. */
export function sinf(x: number): number {
  x = f(x);
  const ax = Math.abs(x);
  if (!(ax < 120)) return f(Math.sin(x));
  if (ax < F_PI4) return ax >= F_TINY ? f(sinPoly(x)) : f(fma32(x, 67108864, x) * 1.4901161193847656e-8);
  return sincosQ(x, rintn(x * TWO_PI_INV));
}

/** Apple's cosf. */
export function cosf(x: number): number {
  const ax = Math.abs(f(x));
  if (!(ax < 120)) return f(Math.cos(ax));
  if (ax < F_PI4) return ax >= F_TINY ? f(cosPoly(ax)) : f(f(67108864 - ax) * 1.4901161193847656e-8);
  return sincosQ(ax, rintn(ax * TWO_PI_INV) + 1);
}

// ------------------------------------------------------------------ powf
// Apple's powf (libsystem_m, macOS 26 arm64): 2^(y log2 x) with log2 from a
// 128-entry table (c = the subinterval's centre, 1 / c, 128 log2 c: generated
// here, identical to Apple's) and a quartic, scaled by 128, and exp2 from the
// 2^(j / 128) table and a quadratic, in double, rounded to float once.
const LOG_INVC = new Float64Array(128);
const LOG_C = new Float64Array(128);
{
  const u = new Uint32Array(1), fl = new Float32Array(u.buffer);
  for (let i = 0; i < 128; i++) {
    u[0] = 0x3f338000 + (i << 16) + 0x8000;
    const c = fl[0];
    LOG_INVC[i] = 1 / c;
    LOG_C[i] = Math.log2(c) * 128;
  }
}
const EP = 1.4662262378543872e-05, EQ = 0.005415217308896754;
const PA = -46.16680486880053, PB = 61.55555197023551, PC = -92.33248261492298, PD = 184.6649652327124;
const powBits = new Uint32Array(2);
const powF = new Float32Array(powBits.buffer);

/** Apple's powf for x > 0 (x = 0: 0 for y > 0); other inputs fall back to Math.pow. */
export function powf(x: number, y: number): number {
  x = f(x); y = f(y);
  if (x === 1) return 1;
  if (y === 1) return x;
  powF[0] = x; powF[1] = y;
  const ix = powBits[0], iy = powBits[1];
  if (((iy & 0x7fffffff) - 1) >>> 0 >= 0x7f7fffff || ((ix - 0x800000) >>> 0) >= 0x7f000000) {
    if (x === 0 && y > 0) return 0;
    return f(Math.pow(x, y));
  }
  const tmp = (ix - 0x3f338000) | 0;
  const i = (tmp >>> 16) & 127;
  const top = tmp & 0xff800000;
  powBits[0] = (ix - top) >>> 0;
  const z = powF[0];
  const r = fmaD(z, LOG_INVC[i], -1);
  const y0 = LOG_C[i] + (top >> 16);
  const r2 = r * r;
  const p = fmaD(fmaD(r, PA, PB), r2, fmaD(r, PC, PD));
  const l = fmaD(p, r, y0);
  let t = y * l;
  t = t < 32768 ? t : 32768;
  t = t > -32768 ? t : -32768;
  const ki = t < 0 ? -Math.round(-t) : Math.round(t); // frinta: halves away from zero
  const rr = t - ki;
  const s = EXP2_128[ki & 127] * Math.pow(2, ki >> 7);
  const e = fmaD(EP, rr, EQ) * rr;
  return f(fmaD(e, s, s));
}

// ------------------------------------------------------------------ exp2f
// Apple's exp2f (|x| < 256): x rounded to a multiple of 1 / 128 (shift
// constant), 2^(n / 128) from the table above, a quadratic, in double.
const EXP2F_SHIFT = 52776558133248; // 1.5 x 2^45
const EXP2F_P = 0.2402265068100628, EXP2F_Q = 0.69314781553878446;

/** Apple's exp2f. */
export function exp2f(x: number): number {
  x = f(x);
  if (!(Math.abs(x) < 256)) return f(Math.pow(2, x));
  const kd = (x + EXP2F_SHIFT) - EXP2F_SHIFT;
  const n = kd * 128;
  const r = x - kd;
  const s = EXP2_128[n & 127] * Math.pow(2, n >> 7);
  return f(fmaD(fmaD(EXP2F_P, r, EXP2F_Q) * r, s, s));
}

// ------------------------------------------------------------------ exp2 (double)
// Apple's exp2 (|x| < 1024): 2^(j / 128) rounded down plus its log2 correction
// (EXP2D_HI / EXP2D_LO: generated from those definitions, identical to Apple's
// table) and a factored quartic.
const EXP2D_HI = [1.0, 1.0054299011128027, 1.0108892860517003, 1.0163783149109529, 1.0218971486541166, 1.0274459491187635, 1.0330248790212284, 1.0386341019613787, 1.0442737824274138, 1.0499440858006872, 1.0556451783605572, 1.0613772272892619, 1.0671404006768235, 1.0729348675259753, 1.0787607977571196, 1.0846183622133092, 1.0905077326652575, 1.0964290818163767, 1.102382583307841, 1.1083684117236785, 1.1143867425958924, 1.1204377524096065, 1.1265216186082418, 1.1326385195987192, 1.1387886347566916, 1.1449721444318042, 1.1511892299529827, 1.157440073633751, 1.1637248587775775, 1.17004376968325, 1.1763969916502812, 1.182784710984341, 1.189207115002721, 1.1956643920398273, 1.202156731452703, 1.2086843236265814, 1.2152473599804687, 1.2218460329727574, 1.2284805361068698, 1.2351510639369332, 1.241857812073484, 1.2486009771892046, 1.2553807570246909, 1.2621973503942505, 1.2690509571917332, 1.275941778396392, 1.2828700160787783, 1.2898358734066657, 1.2968395546510096, 1.3038812651919358, 1.3109612115247642, 1.3180796012660638, 1.325236643159741, 1.3324325470831613, 1.339667524053303, 1.3469417862329458, 1.3542555469368927, 1.3616090206382248, 1.3690024229745905, 1.37643597075453, 1.3839098819638318, 1.391424375771926, 1.398979672538311, 1.4065759938190154, 1.414213562373095, 1.4218926021691654, 1.4296133383919698, 1.4373759974489821, 1.4451808069770464, 1.4530279958490524, 1.4609177941806468, 1.4688504333369818, 1.4768261459394991, 1.4848451658727524, 1.4929077282912648, 1.5010140696264254, 1.5091644275934226, 1.5173590411982145, 1.5255981507445382, 1.533881997840956, 1.5422108254079407, 1.5505848776849998, 1.559004400237837, 1.5674696399655528, 1.5759808451078863, 1.5845382652524935, 1.5931421513422668, 1.6017927556826932, 1.6104903319492543, 1.6192351351948637, 1.6280274218573476, 1.6368674497669644, 1.6457554781539647, 1.6546917676561943, 1.6636765803267364, 1.6727101796415964, 1.681792830507429, 1.690924799269305, 1.7001063537185233, 1.7093377631004627, 1.7186192981224777, 1.7279512309618374, 1.7373338352737062, 1.7467673861991688, 1.7562521603732995, 1.7657884359332727, 1.7753764925265212, 1.785016611318935, 1.7947090750031072, 1.8044541678066237, 1.8142521755003986, 1.8241033854070532, 1.8340080864093424, 1.8439665689586258, 1.8539791250833855, 1.864046048397789, 1.8741676341102997, 1.8843441790323343, 1.8945759815869656, 1.9048633418176741, 1.9152065613971472, 1.9256059436361248, 1.9360617934922943, 1.9465744175792332, 1.9571441241754002, 1.9677712232331757, 1.978456026387951, 1.9891988469672663];
const EXP2D_LO = [0.0, 1.3630417488093622e-16, 2.9514954303918826e-16, 2.3324763575316285e-16, 7.213107132937751e-17, 2.421943599607696e-16, 1.0615129192769027e-17, 8.329010613702792e-17, 1.1814687944889186e-16, 7.685079431005769e-17, 2.40437845088882e-18, 2.855426704231878e-16, 1.9338771996028718e-16, 2.934038110891208e-16, 2.0793056333530939e-16, 4.211428801587433e-17, 2.534478831560779e-16, 2.142738344628859e-16, 6.891695673344946e-17, 1.74649259882721e-16, 1.3477239570329822e-16, 2.0606222079704234e-16, 6.615723839427447e-17, 4.123573061067116e-17, 1.1291358427388442e-16, 5.848147436010016e-17, 4.0738597878590844e-17, 1.6304344120414088e-16, 4.7471485954003274e-17, 2.7150857704300953e-16, 6.811494374623386e-17, 1.8820356574748363e-17, 4.830810003324493e-17, 5.570418643805832e-17, 7.974569043244072e-17, 2.0837688190526678e-16, 1.720414433646299e-16, 1.368895663310128e-16, 2.3846452046994003e-16, 1.3373042246685525e-16, 5.411338755317555e-17, 1.6110023657341897e-16, 2.474628990690543e-16, 2.1854207531475557e-16, 3.0329849510796044e-18, 1.121128117584401e-16, 1.927081356378589e-17, 1.0009839023444114e-16, 2.823727173974899e-17, 9.568324228510986e-17, 1.653252459259429e-16, 1.832977250366625e-16, 2.1060380304340404e-16, 1.8518184173056048e-16, 9.613837834338403e-17, 3.453261886018047e-17, 8.203857878088789e-17, 1.6251271981546345e-18, 1.0110226577342234e-16, 1.604266777417244e-16, 1.6089545810690986e-16, 1.7935686139189312e-16, 1.2983667794432695e-16, 7.215562299616096e-18, 1.2789658787927721e-16, 2.0898009166301543e-16, 2.1193468981590678e-16, 1.8067037474503716e-16, 1.9147710818155917e-16, 1.6307711833820692e-16, 1.6396972328019103e-16, 8.315133244608848e-17, 1.8287815016475356e-16, 1.0474073710050535e-16, 1.371555330198126e-17, 1.5177176055132177e-16, 1.1509623546776212e-16, 1.7015172398988395e-16, 1.0572008294445967e-16, 8.347608077582763e-17, 7.436847846534485e-17, 1.9300993302375514e-16, 3.4991104987394885e-17, 1.0908917420326708e-16, 1.9398596893323566e-16, 1.8456116101871508e-16, 1.0966450648561835e-16, 1.4545493212086916e-16, 2.213297620457818e-17, 1.865816661041584e-17, 1.372797394421913e-16, 6.785115926842783e-17, 1.0588448328064047e-16, 8.407809321950016e-17, 5.108508498564039e-17, 1.44275047580776e-16, 7.033369914725411e-17, 1.069466718024879e-16, 1.8161620863364822e-16, 1.041141560235454e-16, 1.708539391009996e-16, 9.562698602960153e-17, 2.6277325962588097e-17, 9.458608518759825e-17, 2.4316441556717945e-17, 7.730140247329616e-17, 5.224887349914982e-17, 1.2390412553703516e-17, 1.46523268022774e-17, 1.3613597054262445e-16, 9.729227042042366e-17, 9.526335208290271e-17, 2.5826072121629267e-17, 1.272530048359852e-16, 7.596324296237846e-17, 5.062397624420311e-17, 1.2379354014768072e-16, 1.070176040922958e-16, 2.5916476563204388e-17, 4.948577479245438e-17, 8.726432889920159e-17, 9.207489224684617e-17, 7.699383375119433e-17, 5.047959162679407e-17, 6.605367021773594e-17, 8.716953142857286e-17, 2.945157892886043e-17, 5.950890322130885e-18];
const X16 = 7.7356883726021808, X17 = -0.53848899989604226, X18 = 20.999488636892195, X19 = 24.699638838771548, X20 = 0.001336368218757651;

/** Apple's exp2 (double). */
export function exp2d(x: number): number {
  if (!(Math.abs(x) < 1000)) return Math.pow(2, x);
  const m = Math.trunc(x * 128) + (x < 0 || Object.is(x, -0) ? -1 : 0);
  const r = x - m / 128;
  const j = m & 127;
  const hi = EXP2D_HI[j], d2 = r + EXP2D_LO[j];
  const p = ((d2 * X20) * fmaD(d2, r + X16, X18)) * fmaD(d2, r + X17, X19);
  return fmaD(p, hi, hi) * Math.pow(2, m >> 7);
}
