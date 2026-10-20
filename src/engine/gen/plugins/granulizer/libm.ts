// Apple's libm / Accelerate as FL's plugins reach them (arm64 macOS): exp, cos, sin (libsystem_m) and
// vvsin (Accelerate vForce, which FL's ippsSin_64f calls), ported instruction by instruction from the
// arm64 code, so the doubles come out bit for bit as FL's. JS's own Math.exp / cos / sin differ from
// Apple's in the last bit for 4 - 10 % of the arguments; where the next step of FL's code subtracts
// nearly equal values (the sinc kernel's sine recurrence at a source position next to an integer) that
// last bit decides the output, so the Granulizer's grain reader uses these.
//
// They cover the arguments the plugins use (exp: |x| < 700; cos / sin: |x| < 524288; vvsin:
// |x| < 2^23) and defer to Math.* outside, where Apple's code takes other branches (Payne-Hanek
// reduction, denormal results). Verified against the system libm / Accelerate on millions of arguments
// (tests/gen/granulizer.test.ts pins samples).

const buf = new Float64Array(1);
const w32 = new Uint32Array(buf.buffer);

/** The double with these bits. */
function dbl(hi: number, lo: number): number {
  w32[0] = lo; w32[1] = hi;
  return buf[0];
}

const SPLIT = 134217729; // 2^27 + 1

/** Round-to-odd sum (Boldo & Melquiond): the odd one of the two doubles around x + y. */
function sumOdd(x: number, y: number): number {
  const s = x + y;
  const z = s - x;
  const e = (x - (s - z)) + (y - z);
  if (e === 0) return s;
  buf[0] = s;
  if ((w32[0] & 1) === 0) {
    // even: step one unit toward the exact sum, which makes the last bit odd
    if ((e > 0) === (s > 0)) {
      w32[0] = (w32[0] + 1) >>> 0;
      if (w32[0] === 0) w32[1] = (w32[1] + 1) >>> 0;
    } else {
      if (w32[0] === 0) w32[1] = (w32[1] - 1) >>> 0;
      w32[0] = (w32[0] - 1) >>> 0;
    }
    return buf[0];
  }
  return s;
}

/** a x b + c with a single rounding (ARM FMADD / FMLA), exact for finite normal operands. */
export function fma(a: number, b: number, c: number): number {
  const p = a * b;
  if (p === 0 || c === 0 || !Number.isFinite(p) || !Number.isFinite(c)) return p + c;
  let t = SPLIT * a;
  const ah = t - (t - a), al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b), bl = b - bh;
  const pl = ((ah * bh - p) + ah * bl + al * bh) + al * bl; // a b = p + pl exactly
  const th = c + p;
  const z = th - c;
  const tl = (c - (th - z)) + (p - z); // c + p = th + tl exactly
  return th + sumOdd(tl, pl);
}

/** ARM FRINTN / FCVTNS: round half to even. */
function rne(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ------------------------------------------------------------------------------------------------ exp
// libsystem_m exp: x 128 / ln 2 = n + fraction; 2^(n mod 128 / 128) from a table of 128 (high, low) pairs;
// a short polynomial for the fraction; the exponent n >> 7 added to the result's bits.

const EXP_A = dbl(0x40671547, 0x652b82fe);
const EXP_B = dbl(0x3ce777d0, 0xffda0d24);
const EXP_K16 = dbl(0x408ef158, 0x4af17ecd);
const EXP_K17 = dbl(0xc0513b4d, 0x4879e55e);
const EXP_K18 = dbl(0x4114ffde, 0x7cc02cf4);
const EXP_K19 = dbl(0x4118b31b, 0x87eb8904);
const EXP_K20 = dbl(0x3d25e522, 0x72e0eaec);
const EXP_T = new Float64Array([
  1.0, 0.0,
  1.0054299011128027, 1.7446934384759836e-14,
  1.0108892860517003, 3.77791415090161e-14,
  1.0163783149109529, 2.9855697376404845e-14,
  1.0218971486541166, 9.232777130160321e-15,
  1.0274459491187635, 3.100087807497851e-14,
  1.0330248790212284, 1.3587365366744355e-15,
  1.0386341019613787, 1.0661133585539574e-14,
  1.0442737824274138, 1.512280056945816e-14,
  1.0499440858006872, 9.836901671687384e-15,
  1.0556451783605572, 3.0776044171376897e-16,
  1.0613772272892619, 3.654946181416804e-14,
  1.0671404006768235, 2.475362815491676e-14,
  1.0729348675259753, 3.755568781940746e-14,
  1.0787607977571196, 2.66151121069196e-14,
  1.0846183622133092, 5.3906288660319145e-15,
  1.0905077326652575, 3.244132904397797e-14,
  1.0964290818163767, 2.7427050811249394e-14,
  1.102382583307841, 8.821370461881531e-15,
  1.1083684117236785, 2.235510526498829e-14,
  1.1143867425958924, 1.7250866650022173e-14,
  1.1204377524096065, 2.637596426202142e-14,
  1.1265216186082418, 8.468126514467132e-15,
  1.1326385195987192, 5.278173518165908e-15,
  1.1387886347566916, 1.4452938787057205e-14,
  1.1449721444318042, 7.485628718092821e-15,
  1.1511892299529827, 5.214540528459628e-15,
  1.157440073633751, 2.0869560474130033e-14,
  1.1637248587775775, 6.076350202112419e-15,
  1.17004376968325, 3.475309786150522e-14,
  1.1763969916502812, 8.718712799517935e-15,
  1.182784710984341, 2.4090056415677905e-15,
  1.189207115002721, 6.183436804255351e-15,
  1.1956643920398273, 7.130135864071465e-15,
  1.202156731452703, 1.0207448375352412e-14,
  1.2086843236265814, 2.6672240883874148e-14,
  1.2152473599804687, 2.2021304750672628e-14,
  1.2218460329727574, 1.752186449036964e-14,
  1.2284805361068698, 3.0523458620152324e-14,
  1.2351510639369332, 1.7117494075757472e-14,
  1.241857812073484, 6.92651360680647e-15,
  1.2486009771892046, 2.0620830281397628e-14,
  1.2553807570246909, 3.167525108083895e-14,
  1.2621973503942505, 2.7973385640288713e-14,
  1.2690509571917332, 3.8822207373818937e-16,
  1.275941778396392, 1.4350439905080333e-14,
  1.2828700160787783, 2.466664136164594e-15,
  1.2898358734066657, 1.2812593950008466e-14,
  1.2968395546510096, 3.614370782687871e-15,
  1.3038812651919358, 1.2247455012494062e-14,
  1.3109612115247642, 2.116163147852069e-14,
  1.3180796012660638, 2.34621088046928e-14,
  1.325236643159741, 2.6957286789555717e-14,
  1.3324325470831613, 2.370327574151174e-14,
  1.339667524053303, 1.2305712427953156e-14,
  1.3469417862329458, 4.4201752141031e-15,
  1.3542555469368927, 1.050093808395365e-14,
  1.3616090206382248, 2.0801628136379322e-16,
  1.3690024229745905, 1.2941090018998059e-14,
  1.37643597075453, 2.0534614750940722e-14,
  1.3839098819638318, 2.0594618637684462e-14,
  1.391424375771926, 2.295767825816232e-14,
  1.398979672538311, 1.661909477687385e-14,
  1.4065759938190154, 9.235919743508603e-16,
  1.414213562373095, 1.6370763248547483e-14,
  1.4218926021691654, 2.6749451732865975e-14,
  1.4296133383919698, 2.7127640296436068e-14,
  1.4373759974489821, 2.3125807967364757e-14,
  1.4451808069770464, 2.4509069847239573e-14,
  1.4530279958490524, 2.0873871147290486e-14,
  1.4609177941806468, 2.0988124579864452e-14,
  1.4688504333369818, 1.0643370553099326e-14,
  1.4768261459394991, 2.3408403221088456e-14,
  1.4848451658727524, 1.3406814348864685e-14,
  1.4929077282912648, 1.7555908226536013e-15,
  1.5010140696264254, 1.9426785350569187e-14,
  1.5091644275934226, 1.4732318139873552e-14,
  1.5173590411982145, 2.1779420670705145e-14,
  1.5255981507445382, 1.3532170616890838e-14,
  1.533881997840956, 1.0684938339305937e-14,
  1.5422108254079407, 9.51916524356414e-15,
  1.5505848776849998, 2.4705271427040658e-14,
  1.559004400237837, 4.478861438386545e-15,
  1.5674696399655528, 1.3963414298018186e-14,
  1.5759808451078863, 2.4830204023454164e-14,
  1.5845382652524935, 2.362382861039553e-14,
  1.5931421513422668, 1.4037056830159149e-14,
  1.6017927556826932, 1.8618231311471253e-14,
  1.6104903319492543, 2.833020954186007e-15,
  1.6192351351948637, 2.3882453261332276e-15,
  1.6280274218573476, 1.7571806648600487e-14,
  1.6368674497669644, 8.684948386358763e-15,
  1.6457554781539647, 1.355321385992198e-14,
  1.6546917676561943, 1.0761995932096021e-14,
  1.6636765803267364, 6.53889087816197e-15,
  1.6727101796415964, 1.846720609033933e-14,
  1.681792830507429, 9.002713490848526e-15,
  1.690924799269305, 1.3689173990718452e-14,
  1.7001063537185233, 2.3246874705106972e-14,
  1.7093377631004627, 1.3326611971013812e-14,
  1.7186192981224777, 2.186930420492795e-14,
  1.7279512309618374, 1.2240254211788996e-14,
  1.7373338352737062, 3.3634977232112764e-15,
  1.7467673861991688, 1.2107018904012576e-14,
  1.7562521603732995, 3.112504519259897e-15,
  1.7657884359332727, 9.894579516581908e-15,
  1.7753764925265212, 6.687855807891177e-15,
  1.785016611318935, 1.58597280687405e-15,
  1.7947090750031072, 1.8754978306915074e-15,
  1.8044541678066237, 1.742540422945593e-14,
  1.8142521755003986, 1.2453410613814229e-14,
  1.8241033854070532, 1.2193709066611547e-14,
  1.8340080864093424, 3.3057372315685462e-15,
  1.8439665689586258, 1.6288384619006104e-14,
  1.8539791250833855, 9.723295099184443e-15,
  1.864046048397789, 6.479868959257998e-15,
  1.8741676341102997, 1.5845573138903132e-14,
  1.8843441790323343, 1.3698253323813863e-14,
  1.8945759815869656, 3.3173090000901617e-15,
  1.9048633418176741, 6.334179173434161e-15,
  1.9152065613971472, 1.1169834099097803e-14,
  1.9256059436361248, 1.178558620759631e-14,
  1.9360617934922943, 9.855210720152874e-15,
  1.9465744175792332, 6.461387728229641e-15,
  1.9571441241754002, 8.4548697878702e-15,
  1.9677712232331757, 1.1157700022857326e-14,
  1.978456026387951, 3.769802102894135e-15,
  1.9891988469672663, 7.617139612327533e-16
]);

/** libm exp for -700 < x < 700 (Math.exp elsewhere). */
export function appleExp(x: number): number {
  if (!(x > -700 && x < 700)) return Math.exp(x);
  const t = x * EXP_A;
  const n = Math.floor(t);
  const fr = t - n;
  const e1 = fma(-x, EXP_A, t); // t - x A: the rounding error of the product
  const lo = fma(x, EXP_B, -e1);
  const j = (n & 127) * 2;
  const th = EXP_T[j];
  const d2 = fr + (EXP_T[j + 1] + lo);
  const p18 = fma(d2, fr + EXP_K16, EXP_K18);
  const p19 = fma(d2, fr + EXP_K17, EXP_K19);
  const p = ((d2 * EXP_K20) * p18) * p19;
  buf[0] = fma(p, th, th);
  w32[1] = (w32[1] + (Math.floor(n / 128) << 20)) >>> 0;
  return buf[0];
}

// ------------------------------------------------------------------------------------------- cos, sin
// libsystem_m cos / sin: x 2 / pi rounded to the nearest integer n, the remainder from a three-part
// pi / 2 (no fused operations), then a sine or a cosine polynomial of the remainder (hi + lo) by n mod 4.

const TWO_OVER_PI = dbl(0x3fe45f30, 0x6dc9c883);
const PIO2_HI = dbl(0x3ff921fb, 0x54440000);
const PIO2_MID = dbl(0x3d868c23, 0x4c4c0000);
const PIO2_LO = dbl(0x3b298a2e, 0x03707345);
const PIO4 = dbl(0x3fe921fb, 0x54442d18);
const TRIG_MAX = dbl(0x41200001, 0x3be57a40);
const S0 = dbl(0x3de5d8fd, 0x1fd19ccd), S1 = dbl(0xbe5ae5e5, 0xa9291f5d), S2 = dbl(0x3ec71de3, 0x567d48a1);
const S3 = dbl(0xbf2a01a0, 0x19bfdf03), S4 = dbl(0x3f811111, 0x1110f7d0), S5 = dbl(0xbfc55555, 0x55555548);
const C0 = dbl(0xbda8fa49, 0xa0861a9b), C1 = dbl(0x3e21ee9d, 0x7b4e3f05), C2 = dbl(0xbe927e4f, 0x7eac4bc6);
const C3 = dbl(0x3efa01a0, 0x19c844f5), C4 = dbl(0xbf56c16c, 0x16c14f91), C5 = dbl(0x3fa55555, 0x5555554b);
const C6 = -0.5;

function sinKernel(hi: number, lo: number): number {
  const r = hi + lo;
  let q = r * r;
  let d3 = fma(q, S0, S1);
  const d4 = fma(q, d3, S2);
  const d5 = fma(q, d4, S3);
  const d2 = fma(q, d5, S4);
  d3 = fma(q, d2, S5);
  q = q * d3;
  return fma(r, q, lo) + hi;
}

function cosKernel(hi: number, lo: number): number {
  let q = hi * lo;
  q = q + q;
  q = fma(hi, hi, q);
  let d3 = fma(q, C0, C1);
  const d4 = fma(q, d3, C2);
  const d5 = fma(q, d4, C3);
  let d2 = fma(q, d5, C4);
  d3 = fma(q, d2, C5);
  d2 = fma(q, d3, C6);
  return fma(q, d2, 1);
}

let rHi = 0, rLo = 0, rN = 0;
function reduce(x: number): void {
  const d2 = rne(x * TWO_OVER_PI);
  rN = d2;
  const d5 = d2 * PIO2_HI;
  const d1 = d2 * PIO2_MID;
  const d7 = d2 * PIO2_LO;
  const d0 = x - d5;
  rHi = d0 - d1;
  rLo = ((d0 - rHi) - d1) - d7;
}

/** libm sin for |x| < 524288 (Math.sin beyond). */
export function appleSin(x: number): number {
  if (x === 0) return x;
  const a = Math.abs(x);
  if (a <= PIO4) return sinKernel(0, x);
  if (!(a < TRIG_MAX)) return Math.sin(x);
  reduce(x);
  const m = ((rN % 4) + 4) % 4;
  const v = (m & 1) !== 0 ? cosKernel(rHi, rLo) : sinKernel(rHi, rLo);
  return (m & 2) !== 0 ? -v : v;
}

/** libm cos for |x| < 524288 (Math.cos beyond). */
export function appleCos(x: number): number {
  const a = Math.abs(x);
  if (a <= PIO4) return cosKernel(a, 0);
  if (!(a < TRIG_MAX)) return Math.cos(x);
  reduce(a);
  const m = rN % 4;
  const v = (m & 1) !== 0 ? sinKernel(rHi, rLo) : cosKernel(rHi, rLo);
  return ((m ^ (m >> 1)) & 1) !== 0 ? -v : v;
}

// --------------------------------------------------------------------------------------------- vvsin
// Accelerate vvsin (libvMisc VVSIN): k = round(|x| / pi) by the magic-number trick, |x| - k pi with a
// three-part pi (fused), the sign flipped for odd k, an odd polynomial in the remainder.

const V_INVPI = dbl(0x3fd45f30, 0x6dc9c883);
const V_MAGIC = dbl(0x43380000, 0x00000000);
const V_C1 = dbl(0xc00921fb, 0x54442d18);
const V_C2 = dbl(0xbca1a626, 0x33145c06);
const V_C3 = dbl(0xb95c1cd1, 0x29024e09);
const V_P0 = dbl(0xbd69f151, 0x7e9f65f0), V_P1 = dbl(0x3de60e6b, 0xee01d83e), V_P2 = dbl(0xbe5ae635, 0x5aaa4a53);
const V_P3 = dbl(0x3ec71de3, 0x806add1a), V_P4 = dbl(0xbf2a01a0, 0x19a659dd), V_P5 = dbl(0x3f811111, 0x1110a573);
const V_P6 = dbl(0xbfc55555, 0x555554a8);

/** Accelerate's double sine for |x| < 2^23 (Math.sin beyond). */
export function vvsin(x: number): number {
  const a = Math.abs(x);
  if (!(a < 8388608)) return Math.sin(x);
  const kk = fma(V_INVPI, a, V_MAGIC);
  buf[0] = kk;
  const odd = (w32[0] & 1) !== 0;
  const kf = kk - V_MAGIC;
  let r = fma(V_C1, kf, a);
  r = fma(V_C2, kf, r);
  r = fma(V_C3, kf, r);
  const z = odd ? -r : r;
  const z2 = z * z;
  const z3 = z2 * z;
  let u = fma(V_P0, z2, V_P1);
  u = fma(u, z2, V_P2);
  u = fma(u, z2, V_P3);
  u = fma(u, z2, V_P4);
  u = fma(u, z2, V_P5);
  u = fma(u, z2, V_P6);
  const s = fma(u, z3, z);
  return x < 0 || (x === 0 && 1 / x < 0) ? -s : s;
}
