// Apple's libm expf and tanf (macOS arm64 libsystem_m), ported instruction by
// instruction for Fruity Slicer 2's engine (FL's engine.dylib calls them for the
// envelope curves and the state variable filters). They are not correctly
// rounded (about 1 result in 250 differs from the nearest float), so a port that
// wants FL's exact samples needs them. Double arithmetic with the arm64 fused
// multiply-adds emulated exactly (fmaD). Arguments float32, results float32.
// Only the argument ranges the engine uses are ported exactly: expf for
// |x| < 128 (larger arguments saturate as Apple's do), tanf for |x| < 2^26
// (larger arguments fall back to Math.tan).

import { fmaD } from '../drumpad/libm';

const f32 = Math.fround;
const dv = new DataView(new ArrayBuffer(8));

function fromHex(s: string): number {
  dv.setUint32(0, parseInt(s.slice(0, 8), 16));
  dv.setUint32(4, parseInt(s.slice(8, 16), 16));
  return dv.getFloat64(0);
}
function fbits(x: number): number {
  dv.setFloat32(0, x);
  return dv.getUint32(0);
}

/** expf's table: 2^(i/128) as doubles (Apple stores them with i << 45 subtracted from the bits). */
const EXP_TAB_HEX = [
  '3ff00000000000003ff0163da9fb33353ff02c9a3e7780613ff04315e86e7f853ff059b0d31585743ff0706b29ddf6de3ff0874518759bc83ff09e3ecac6f383',
  '3ff0b5586cf9890f3ff0cc922b7247f73ff0e3ec32d3d1a23ff0fb66affed31b3ff11301d0125b513ff12abdc06c31cc3ff1429aaea92de03ff15a98c8a58e51',
  '3ff172b83c7d517b3ff18af9388c8dea3ff1a35beb6fcb753ff1bbe084045cd43ff1d4873168b9aa3ff1ed5022fcd91d3ff2063b88628cd63ff21f49917ddc96',
  '3ff2387a6e7562383ff251ce4fb2a63f3ff26b4565e27cdd3ff284dfe1f563813ff29e9df51fdee13ff2b87fd0dad9903ff2d285a6e4030b3ff2ecafa93e2f56',
  '3ff306fe0a31b7153ff32170fc4cd8313ff33c08b26416ff3ff356c55f929ff13ff371a7373aa9cb3ff38cae6d05d8663ff3a7db34e59ff73ff3c32dc313a8e5',
  '3ff3dea64c1234223ff3fa4504ac801c3ff4160a21f72e2a3ff431f5d950a8973ff44e086061892d3ff46a41ed1d00573ff486a2b5c13cd03ff4a32af0d7d3de',
  '3ff4bfdad5362a273ff4dcb299fddd0d3ff4f9b2769d2ca73ff516daa2cf66423ff5342b569d4f823ff551a4ca5d920f3ff56f4736b527da3ff58d12d497c7fd',
  '3ff5ab07dd4854293ff5c9268a5946b73ff5e76f15ad21483ff605e1b976dc093ff6247eb03a55853ff6434634ccc3203ff66238825522253ff68155d44ca973',
  '3ff6a09e667f3bcd3ff6c012750bdabf3ff6dfb23c651a2f3ff6ff7df95194843ff71f75e8ec5f743ff73f9a48a581743ff75feb564267c93ff780694fde5d3f',
  '3ff7a11473eb01873ff7c1ed0130c1323ff7e2f336cf4e623ff80427543e1a123ff82589994cce133ff8471a4623c7ad3ff868d99b4492ed3ff88ac7d98a6699',
  '3ff8ace5422aa0db3ff8cf3216b5448c3ff8f1ae991577363ff9145b0b91ffc63ff93737b0cdc5e53ff95a44cbc8520f3ff97d829fde4e503ff9a0f170ca07ba',
  '3ff9c49182a3f0903ff9e86319e323233ffa0c667b5de5653ffa309bec4a2d333ffa5503b23e255d3ffa799e1330b3583ffa9e6b5579fdbf3ffac36bbfd3f37a',
  '3ffae89f995ad3ad3ffb0e07298db6663ffb33a2b84f15fb3ffb59728de5593a3ffb7f76f2fb5e473ffba5b030a1064a3ffbcc1e904bc1d23ffbf2c25bd71e09',
  '3ffc199bdd85529c3ffc40ab5fffd07a3ffc67f12e57d14b3ffc8f6d9406e7b53ffcb720dcef90693ffcdf0b555dc3fa3ffd072d4a07897c3ffd2f87080d89f2',
  '3ffd5818dcfba4873ffd80e316c983983ffda9e603db32853ffdd321f301b4603ffdfc97337b9b5f3ffe264614f5a1293ffe502ee78b3ff63ffe7a51fbc74c83',
  '3ffea4afa2a490da3ffecf482d8e67f13ffefa1bee615a273fff252b376bba973fff50765b6e45403fff7bfdad9cbe143fffa7c1819e90d83fffd3c22b8f71f1'
].join('');
const EXP_TAB = new Float64Array(128);
for (let i = 0; i < 128; i++) EXP_TAB[i] = fromHex(EXP_TAB_HEX.slice(16 * i, 16 * i + 16));

const EXP_K = fromHex('40671547652b82fe'); // 128 / ln 2
const EXP_RND = 6755399441055744; // 1.5 * 2^52
const EXP_C2 = fromHex('3EEEBFBDFF30D656'); // 0x1.ebfbdff30d656p-17
const EXP_C1 = fromHex('3F762E4453E10DAE'); // 0x1.62e4453e10daep-8
const FLT_MAX = 3.4028234663852886e38;

/** Apple's expf (float32 in, float32 out). */
export function expf(x: number): number {
  const b = fbits(x);
  if (((b >>> 23) & 0xff) >= 0x86) {
    if (Number.isNaN(x)) return x;
    if (x < 0) return 0;
    return f32(x * FLT_MAX);
  }
  const d1 = fmaD(EXP_K, x, EXP_RND);
  const k = d1 - EXP_RND;
  const r = fmaD(EXP_K, x, -k);
  const p = fmaD(EXP_C2, r, EXP_C1) * r;
  const s = EXP_TAB[k & 127] * Math.pow(2, k >> 7);
  return f32(fmaD(p, s, s));
}

const TAN_2PI = fromHex('3FE45F306E000000'); // 0x1.45f306ep-1 (2 / pi, 28 bits)
const TAN_2PI_LO = fromHex('BDFB1BBEAD603D8B'); // -0x1.b1bbead603d8bp-32
/** tan near 0 (|x| < pi/4): x + x^3 P(x^2). */
const TAN_A = [
  fromHex('3F6FE5DA804EFBDC'), fromHex('3F51E9C887F6C8A1'), fromHex('3F8487DA95C9F173'), fromHex('3F961EB51F86747C'),
  fromHex('3FABA586A7F44AE7'), fromHex('3FC1110746E09B07'), fromHex('3FD555555D8D8930'),
];
/** tan(r pi / 2) for the reduced argument r (|r| <= 1/2). */
const TAN_B = [
  fromHex('40151D4A014005D8'), fromHex('400E91F74C2EEAAB'), fromHex('BFD609394A49ADF1'), fromHex('BFF88F856CDE0B64'),
  fromHex('3FED3764811481D2'), fromHex('3FE81BA4203C502D'), fromHex('3FEDB0D5BE6B368B'), fromHex('3FE2D17A5CC6B70B'),
];

/** Round to nearest, ties to even (arm64 FCVTNS / FRINTN). */
function rne(v: number): number {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Apple's tanf (float32 in, float32 out). */
export function tanf(x: number): number {
  const a = fbits(x) & 0x7fffffff;
  if (a >= 0x4c800000) return f32(Math.tan(x));
  if (a >= 0x3f490fdb) {
    const d2 = x * TAN_2PI;
    const k = rne(d2);
    const r = fmaD(x, TAN_2PI_LO, d2 - k);
    const r2 = r * r;
    const d5 = r * fmaD(r2, TAN_B[0], TAN_B[1]);
    const d17 = fmaD(r2, r2 + TAN_B[2], TAN_B[5]);
    const d18 = fmaD(r2, r2 + TAN_B[3], TAN_B[6]);
    const d19 = fmaD(r2, r2 + TAN_B[4], TAN_B[7]);
    let y = (d5 * d17) * (d18 * d19);
    if (k & 1) y = -1 / y;
    return f32(y);
  }
  if (a >= 0x39800000) {
    const x2 = x * x;
    const d6 = fmaD(x2, TAN_A[1], TAN_A[2]);
    const d16 = fmaD(x2, TAN_A[3], TAN_A[4]);
    let d18 = fmaD(x2, TAN_A[5], TAN_A[6]);
    const x4 = x2 * x2;
    const e6 = fmaD(x4, TAN_A[0], d6);
    d18 = fmaD(x4, d16, d18);
    d18 = fmaD(x4 * x4, e6, d18);
    return f32(fmaD(x, x2 * d18, x));
  }
  return f32(f32(x * 67108864 + x) * 1.4901161193847656e-8);
}
