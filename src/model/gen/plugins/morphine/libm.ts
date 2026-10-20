// Morphine (FL: Morphine) numeric helpers shared by the model (value texts) and
// the engine: exact double fused multiply-add and macOS libm's double exp2 /
// __exp10 ported instruction by instruction (libsystem_m.dylib, macOS 26 arm64:
// exp2 and __exp10 are the same table-driven kernel: 2^(k/128) from a 128-entry
// table (hi, lo) and a degree-5 polynomial; the tables and coefficients below
// were read from the running library). FL's Morphine (C++, clang, arm64) calls
// them for pitch (220 * 2^(semi/12 - 4.75)), rate speeds, the noise filter
// cutoff and ratio and the ADSR curves (exp10); V8's Math.pow differs from them
// in the last bit for ~0.2 % of the arguments, which shifts accumulated
// positions (Morphine keeps its timeline / envelope times in doubles).

const SPLIT = 134217729; // 2^27 + 1
const DV = new DataView(new ArrayBuffer(8));

/** x + y rounded to odd (exact sum when representable, else the neighbour with an odd last bit). */
function addRO(x: number, y: number): number {
  const s = x + y;
  const bb = s - x;
  const e = (x - (s - bb)) + (y - bb);
  if (e === 0 || !Number.isFinite(s)) return s;
  DV.setFloat64(0, s);
  const lo = DV.getUint32(4);
  if ((lo & 1) !== 0) return s;
  const up = (e > 0) === (s > 0);
  let hi = DV.getUint32(0), l = lo;
  if (up) { l = (l + 1) >>> 0; if (l === 0) hi = (hi + 1) >>> 0; }
  else { if (l === 0) hi = (hi - 1) >>> 0; l = (l - 1) >>> 0; }
  DV.setUint32(0, hi);
  DV.setUint32(4, l);
  return DV.getFloat64(0);
}

/** double fused multiply-add a * b + c with a single rounding (arm64 fmadd d). */
export function fmaD(a: number, b: number, c: number): number {
  const p = a * b;
  if (!Number.isFinite(p) || p === 0) return p + c;
  let t = SPLIT * a;
  const ah = t - (t - a), al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  const s = p + c;
  let bb = s - p;
  const err = (p - (s - bb)) + (c - bb);
  const u = err + e;
  bb = u - err;
  const v = (err - (u - bb)) + (e - bb);
  const w = s + u;
  bb = w - s;
  const z = (s - (w - bb)) + (u - bb);
  return w + addRO(z, v);
}

function hx(s: string): Float64Array {
  const out = new Float64Array(s.length / 16);
  for (let i = 0; i < out.length; i++) {
    DV.setUint32(0, parseInt(s.slice(i * 16, i * 16 + 8), 16));
    DV.setUint32(4, parseInt(s.slice(i * 16 + 8, i * 16 + 16), 16));
    out[i] = DV.getFloat64(0);
  }
  return out;
}

/** 2^(j/128), j = 0..127: high parts, and the low parts as exp2 (T_LO2) and __exp10 / exp (T_LO10, 2^7 x) use them. */
const T_HI = hx(
  '3ff00000000000003ff0163da9fb33353ff02c9a3e7780603ff04315e86e7f843ff059b0d31585743ff0706b29ddf6dd3ff0874518759bc8' +
  '3ff09e3ecac6f3833ff0b5586cf9890f3ff0cc922b7247f73ff0e3ec32d3d1a23ff0fb66affed31a3ff11301d0125b503ff12abdc06c31cb' +
  '3ff1429aaea92ddf3ff15a98c8a58e513ff172b83c7d517a3ff18af9388c8de93ff1a35beb6fcb753ff1bbe084045cd33ff1d4873168b9aa' +
  '3ff1ed5022fcd91c3ff2063b88628cd63ff21f49917ddc963ff2387a6e7562383ff251ce4fb2a63f3ff26b4565e27cdd3ff284dfe1f56380' +
  '3ff29e9df51fdee13ff2b87fd0dad98f3ff2d285a6e4030b3ff2ecafa93e2f563ff306fe0a31b7153ff32170fc4cd8313ff33c08b26416ff' +
  '3ff356c55f929ff03ff371a7373aa9ca3ff38cae6d05d8653ff3a7db34e59ff63ff3c32dc313a8e43ff3dea64c1234223ff3fa4504ac801b' +
  '3ff4160a21f72e293ff431f5d950a8963ff44e086061892d3ff46a41ed1d00573ff486a2b5c13cd03ff4a32af0d7d3de3ff4bfdad5362a27' +
  '3ff4dcb299fddd0d3ff4f9b2769d2ca63ff516daa2cf66413ff5342b569d4f813ff551a4ca5d920e3ff56f4736b527da3ff58d12d497c7fd' +
  '3ff5ab07dd4854293ff5c9268a5946b73ff5e76f15ad21483ff605e1b976dc083ff6247eb03a55843ff6434634ccc31f3ff6623882552224' +
  '3ff68155d44ca9733ff6a09e667f3bcc3ff6c012750bdabe3ff6dfb23c651a2e3ff6ff7df95194833ff71f75e8ec5f733ff73f9a48a58173' +
  '3ff75feb564267c83ff780694fde5d3f3ff7a11473eb01863ff7c1ed0130c1323ff7e2f336cf4e623ff80427543e1a113ff82589994cce12' +
  '3ff8471a4623c7ac3ff868d99b4492ec3ff88ac7d98a66993ff8ace5422aa0db3ff8cf3216b5448b3ff8f1ae991577363ff9145b0b91ffc5' +
  '3ff93737b0cdc5e43ff95a44cbc8520e3ff97d829fde4e4f3ff9a0f170ca07b93ff9c49182a3f0903ff9e86319e323233ffa0c667b5de564' +
  '3ffa309bec4a2d333ffa5503b23e255c3ffa799e1330b3583ffa9e6b5579fdbf3ffac36bbfd3f3793ffae89f995ad3ad3ffb0e07298db665' +
  '3ffb33a2b84f15fa3ffb59728de559393ffb7f76f2fb5e463ffba5b030a106493ffbcc1e904bc1d23ffbf2c25bd71e083ffc199bdd85529c' +
  '3ffc40ab5fffd07a3ffc67f12e57d14b3ffc8f6d9406e7b53ffcb720dcef90693ffcdf0b555dc3f93ffd072d4a07897b3ffd2f87080d89f1' +
  '3ffd5818dcfba4873ffd80e316c983973ffda9e603db32853ffdd321f301b4603ffdfc97337b9b5e3ffe264614f5a1283ffe502ee78b3ff6' +
  '3ffe7a51fbc74c833ffea4afa2a490d93ffecf482d8e67f03ffefa1bee615a273fff252b376bba973fff50765b6e45403fff7bfdad9cbe13' +
  '3fffa7c1819e90d83fffd3c22b8f71f1',
);
const T_LO2 = hx(
  '00000000000000003ca3a4bc88ab6f0b3cb5448c4f3a3faa3cb0cea8d139df853c94ca556a1b2fa83cb173b2871f22173c687a10f84f53b7' +
  '3c9801b99f4f5b183ca106d9ba2534013c96269675ff4e353c462d2d983e68443cb4935522e055583cabdebf5fb679593cb5245852cc8960' +
  '3cadf748a567f8da3c8846f8d141b1d03cb24349c9dfc2053caee14f25e668323c93dd2c819e09083ca92b6b9f4c306a3ca36c3949dfc34e' +
  '3cadb25aa6565c953c93118ae698d2063c87c551db68456f3ca045c6a6d3eecb3c90db2bd14acf323c877bf4b6a482143ca77f3dc394bd27' +
  '3c8b5d8e0885ab1b3cb390730108bc383c93a1fee8c9225c3c75b2c9eff609113c8bd9046b69ea243c900e3e54fb7d753c96fc3180aac683' +
  '3cae07c0017dfc4a3ca8cb357ddac3013ca3ba556658c94d3cb12ee4dbdbae863ca345c8212d22783c8f31b9fb32e2e43ca7378cb7144a8a' +
  '3cb1d4e28014ce073caf7ec78b0a541a3c4bf96ee8afb9fb3ca0283b91b051a33c7637bd8150db7d3c9cd9f521d33a363c804715f70da237' +
  '3c9b942d586961a73ca7d36cccde36a53caa6a7e10f267453cae59e8ae6a99de3caab0010b956f3f3c9bb5c29f573dd83c83e81d7478cc39' +
  '3c97a560f05eeddb3c3dfa723ae1bf173c9d2407ce0f64333ca71eb321c101b53ca72ffea320da873ca9d919a952ca953ca2b620c0998aac' +
  '3c60a350f225390e3ca26e8d1ea7de883cae1e012931967d3cae8b028d2e51bb3caa098f71bcc9b03cab984227e443e33ca7807bd5e512c0' +
  '3ca7a16a40378bdb3c97f77c42eaf1473caa5b034b27b2443c9e308095c8fab23c6fa03bd08bcda33ca5df63c009a8453ca0964d359847c9' +
  '3ca8857d98c4418d3c9e78c3e7b184a03c980f72957b04843c956f6cd720fba33cabd0cf46f2f2b23c842bc69235780f3c9f715c3d56cd59' +
  '3cabf4d1acf902db3caa991ae1b508223c9f9bcff58b04aa3ca4f656fe0ffb053c7984806660caa63c7582eb35cac3f33ca3c8ba7b0b1398' +
  '3c938e88295250ef3c9e84e556f025f43c983bde4707301a3c8d72d3f1e40a933ca4cacf4c4b05e23c9445b6038d70183c9ed34583749cd0' +
  '3caa2c7497c166703c9e0244cd9df3b73ca89f65d4b960703c9b9006b1da3a393c7e4bb29d39c3a33c9b4338a23cfc573c7c08f260a0042a' +
  '3c9647d6355e9b743c8e1e92a1c04f0d3c6c920234dbf34d3c70e49a8304ef1f3ca39e87e388d84e3c9c0ae7070a6c513c9b7531d7fbf731' +
  '3c7dc682d68358e23ca256cea656ebcd3c95e519170917783c8d2ec7bfc90fd93ca1d72cedf8d91c3c9ed88162f63e733c7de1319abb2ae2' +
  '3c8c86cfb6cd46e43c9926f89159b0a13c9a89ed8a4d42063c963124664aaf803c8d19790d732ab43c9309e68da0499f3c991ff9e4e92cf9' +
  '3c80fa4931906b803c5b71923d729650',
);
const T_LO10 = hx(
  '00000000000000003d13a4bc88ab6f0b3d25448c4f3a3faa3d20cea8d139df853d04ca556a1b2fa83d2173b2871f22173cd87a10f84f53b7' +
  '3d0801b99f4f5b183d1106d9ba2534013d06269675ff4e353cb62d2d983e68443d24935522e055583d1bdebf5fb679593d25245852cc8960' +
  '3d1df748a567f8da3cf846f8d141b1d03d224349c9dfc2053d1ee14f25e668323d03dd2c819e09083d192b6b9f4c306a3d136c3949dfc34e' +
  '3d1db25aa6565c953d03118ae698d2063cf7c551db68456f3d1045c6a6d3eecb3d00db2bd14acf323cf77bf4b6a482143d177f3dc394bd27' +
  '3cfb5d8e0885ab1b3d2390730108bc383d03a1fee8c9225c3ce5b2c9eff609113cfbd9046b69ea243d000e3e54fb7d753d06fc3180aac683' +
  '3d1e07c0017dfc4a3d18cb357ddac3013d13ba556658c94d3d212ee4dbdbae863d1345c8212d22783cff31b9fb32e2e43d17378cb7144a8a' +
  '3d21d4e28014ce073d1f7ec78b0a541a3cbbf96ee8afb9fb3d10283b91b051a33ce637bd8150db7d3d0cd9f521d33a363cf04715f70da237' +
  '3d0b942d586961a73d17d36cccde36a53d1a6a7e10f267453d1e59e8ae6a99de3d1ab0010b956f3f3d0bb5c29f573dd83cf3e81d7478cc39' +
  '3d07a560f05eeddb3cadfa723ae1bf173d0d2407ce0f64333d171eb321c101b53d172ffea320da873d19d919a952ca953d12b620c0998aac' +
  '3cd0a350f225390e3d126e8d1ea7de883d1e1e012931967d3d1e8b028d2e51bb3d1a098f71bcc9b03d1b984227e443e33d17807bd5e512c0' +
  '3d17a16a40378bdb3d07f77c42eaf1473d1a5b034b27b2443d0e308095c8fab23cdfa03bd08bcda33d15df63c009a8453d10964d359847c9' +
  '3d18857d98c4418d3d0e78c3e7b184a03d080f72957b04843d056f6cd720fba33d1bd0cf46f2f2b23cf42bc69235780f3d0f715c3d56cd59' +
  '3d1bf4d1acf902db3d1a991ae1b508223d0f9bcff58b04aa3d14f656fe0ffb053ce984806660caa63ce582eb35cac3f33d13c8ba7b0b1398' +
  '3d038e88295250ef3d0e84e556f025f43d083bde4707301a3cfd72d3f1e40a933d14cacf4c4b05e23d0445b6038d70183d0ed34583749cd0' +
  '3d1a2c7497c166703d0e0244cd9df3b73d189f65d4b960703d0b9006b1da3a393cee4bb29d39c3a33d0b4338a23cfc573cec08f260a0042a' +
  '3d0647d6355e9b743cfe1e92a1c04f0d3cdc920234dbf34d3ce0e49a8304ef1f3d139e87e388d84e3d0c0ae7070a6c513d0b7531d7fbf731' +
  '3cedc682d68358e23d1256cea656ebcd3d05e519170917783cfd2ec7bfc90fd93d11d72cedf8d91c3d0ed88162f63e733cede1319abb2ae2' +
  '3cfc86cfb6cd46e43d0926f89159b0a13d0a89ed8a4d42063d063124664aaf803cfd19790d732ab43d0309e68da0499f3d091ff9e4e92cf9' +
  '3cf0fa4931906b803ccb71923d729650',
);

if (T_HI.length !== 128 || T_LO2.length !== 128 || T_LO10.length !== 128) throw new Error('morphine libm: bad tables');

const E2 = hx('401ef1584af17ecdbfe13b4d4879e55e4034ffde7cc02cf44038b31b87eb89043f55e52272e0eaec');
const E10 = hx('408ef1584af17ecdc0513b4d4879e55e4114ffde7cc02cf44118b31b87eb89043d25e52272e0eaec');
const L10 = hx('407a934f0979a372bd2406db502402ca'); // 128 log2(10) hi, lo

/** bits(x) + (e << 52): libm's exponent adjustment (integer add on the bit pattern). */
function addExp(x: number, e: number): number {
  DV.setFloat64(0, x);
  DV.setUint32(0, (DV.getUint32(0) + e * 0x100000) >>> 0);
  return DV.getFloat64(0);
}

/** libm exp2 (double). */
export function exp2(x: number): number {
  if (!(x < 1024 && x > -1022)) return Math.pow(2, x); // overflow / subnormal paths (never reached by Morphine)
  // k = trunc(x * 128) (+ -1 for negative x): fcvtzs #7 then add the sign word
  let k = Math.trunc(x * 128);
  if (x < 0) k -= 1;
  const r = x - k / 128;
  const j = k & 127;
  const t0 = T_HI[j];
  const d2 = r + T_LO2[j];
  const d18 = fmaD(d2, r + E2[0], E2[2]);
  const d19 = fmaD(d2, r + E2[1], E2[3]);
  const p = ((d2 * E2[4]) * d18) * d19;
  return addExp(fmaD(p, t0, t0), k >> 7);
}

/** libm __exp10 (double). */
export function exp10(x: number): number {
  if (!(x < 308.25 && x > -307)) return Math.pow(10, x); // overflow / subnormal paths (never reached by Morphine)
  const d1 = x * L10[0];
  const k = Math.floor(d1); // fcvtms
  const r = d1 - k;
  const rem = fmaD(-x, L10[0], d1); // fmsub: d1 - x*C0
  const corr = fmaD(x, L10[1], -rem); // fnmsub: x*C1 - rem
  const j = k & 127;
  const t0 = T_HI[j];
  const d2 = r + (T_LO10[j] + corr);
  const d18 = fmaD(d2, r + E10[0], E10[2]);
  const d19 = fmaD(d2, r + E10[1], E10[3]);
  const p = ((d2 * E10[4]) * d18) * d19;
  return addExp(fmaD(p, t0, t0), Math.floor(k / 128));
}
