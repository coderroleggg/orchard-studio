// Apple's libm float functions (macOS arm64 libsystem_m: cosf, sinf, __sincosf_stret, exp2f,
// __exp10f, logf) ported instruction by instruction, tables included: FL's plug-ins call these,
// and they are not correctly rounded (cosf / sinf differ from the nearest float about once in
// 80 calls), so a port that wants FL's exact samples needs them. Double arithmetic with the
// fused multiply-adds emulated exactly (fmaD). Arguments are float32 values; results float32.
// Only the argument ranges FL's plug-ins use are ported (|x| < 2^26 for the trig functions;
// larger arguments fall back to Math).

import { fmaD } from './dsp';

const f32 = Math.fround;
const dv = new DataView(new ArrayBuffer(8));
function hx(...parts: string[]): Float64Array {
  const s = parts.join('');
  const out = new Float64Array(s.length / 16);
  for (let i = 0; i < out.length; i++) {
    dv.setUint32(0, parseInt(s.slice(i * 16, i * 16 + 8), 16));
    dv.setUint32(4, parseInt(s.slice(i * 16 + 8, i * 16 + 16), 16));
    out[i] = dv.getFloat64(0);
  }
  return out;
}
const bitsHi = (d: number): number => { dv.setFloat64(0, d); return dv.getUint32(0); };
const bitsLo = (d: number): number => { dv.setFloat64(0, d); return dv.getUint32(4); };
const fromBits = (hi: number, lo: number): number => { dv.setUint32(0, hi >>> 0); dv.setUint32(4, lo >>> 0); return dv.getFloat64(0); };
const fbuf = new DataView(new ArrayBuffer(4));
const fbits = (x: number): number => { fbuf.setFloat32(0, x); return fbuf.getUint32(0); };

const EXP_C = hx(
  '3fcebfbdff30d6563fe62e4453e10dae3eeebfbdff30d6563f762e4453e10dae',
);
const EXP_T = hx(
  '3ff00000000000003feff63da9fb33353fefec9a3e7780613fefe315e86e7f853fefd9b0d31585743fefd06b29ddf6de',
  '3fefc74518759bc83fefbe3ecac6f3833fefb5586cf9890f3fefac922b7247f73fefa3ec32d3d1a23fef9b66affed31b',
  '3fef9301d0125b513fef8abdc06c31cc3fef829aaea92de03fef7a98c8a58e513fef72b83c7d517b3fef6af9388c8dea',
  '3fef635beb6fcb753fef5be084045cd43fef54873168b9aa3fef4d5022fcd91d3fef463b88628cd63fef3f49917ddc96',
  '3fef387a6e7562383fef31ce4fb2a63f3fef2b4565e27cdd3fef24dfe1f563813fef1e9df51fdee13fef187fd0dad990',
  '3fef1285a6e4030b3fef0cafa93e2f563fef06fe0a31b7153fef0170fc4cd8313feefc08b26416ff3feef6c55f929ff1',
  '3feef1a7373aa9cb3feeecae6d05d8663feee7db34e59ff73feee32dc313a8e53feedea64c1234223feeda4504ac801c',
  '3feed60a21f72e2a3feed1f5d950a8973feece086061892d3feeca41ed1d00573feec6a2b5c13cd03feec32af0d7d3de',
  '3feebfdad5362a273feebcb299fddd0d3feeb9b2769d2ca73feeb6daa2cf66423feeb42b569d4f823feeb1a4ca5d920f',
  '3feeaf4736b527da3feead12d497c7fd3feeab07dd4854293feea9268a5946b73feea76f15ad21483feea5e1b976dc09',
  '3feea47eb03a55853feea34634ccc3203feea238825522253feea155d44ca9733feea09e667f3bcd3feea012750bdabf',
  '3fee9fb23c651a2f3fee9f7df95194843fee9f75e8ec5f743fee9f9a48a581743fee9feb564267c93feea0694fde5d3f',
  '3feea11473eb01873feea1ed0130c1323feea2f336cf4e623feea427543e1a123feea589994cce133feea71a4623c7ad',
  '3feea8d99b4492ed3feeaac7d98a66993feeace5422aa0db3feeaf3216b5448c3feeb1ae991577363feeb45b0b91ffc6',
  '3feeb737b0cdc5e53feeba44cbc8520f3feebd829fde4e503feec0f170ca07ba3feec49182a3f0903feec86319e32323',
  '3feecc667b5de5653feed09bec4a2d333feed503b23e255d3feed99e1330b3583feede6b5579fdbf3feee36bbfd3f37a',
  '3feee89f995ad3ad3feeee07298db6663feef3a2b84f15fb3feef9728de5593a3feeff76f2fb5e473fef05b030a1064a',
  '3fef0c1e904bc1d23fef12c25bd71e093fef199bdd85529c3fef20ab5fffd07a3fef27f12e57d14b3fef2f6d9406e7b5',
  '3fef3720dcef90693fef3f0b555dc3fa3fef472d4a07897c3fef4f87080d89f23fef5818dcfba4873fef60e316c98398',
  '3fef69e603db32853fef7321f301b4603fef7c97337b9b5f3fef864614f5a1293fef902ee78b3ff63fef9a51fbc74c83',
  '3fefa4afa2a490da3fefaf482d8e67f13fefba1bee615a273fefc52b376bba973fefd0765b6e45403fefdbfdad9cbe14',
  '3fefe7c1819e90d83feff3c22b8f71f1',
);
const LOG_C = hx(
  '3fd55561555ccbadbfe00006000349d23fefffffffff66663fe62e42fefa39ef',
);
const LOG_T = hx(
  '3ff000000000000000000000000000003fefc07f01fc07f03f7fe02a6b1067893fef81f81f81f8203f8fc0a8b0fc03e4',
  '3fef44659e4a42713f97b91b07d5b11b3fef07c1f07c1f083f9f829b0e7833003feecc07b301ecc03fa39e87b9febd60',
  '3fee9131abf0b7673fa77458f632dcfc3fee573ac901e5743fab42dd711971bf3fee1e1e1e1e1e1e3faf0a30c01162a6',
  '3fede5d6e3f8868a3fb16536eea37ae13fedae6076b981db3fb341d7961bd1d13fed77b654b82c343fb51b073f06183f',
  '3fed41d41d41d41d3fb6f0d28ae56b4c3fed0cb58f6ec0743fb8c345d6319b213fecd85689039b0b3fba926d3a4ad563',
  '3feca4b3055ee1913fbc5e548f5bc7433fec71c71c71c71c3fbe27076e2af2e63fec3f8f01c3f8f03fbfec9131dbeabb',
  '3fec0e070381c0e03fc0d77e7cd08e593febdd2b899406f73fc1b72ad52f67a03febacf914c1bad03fc29552f81ff523',
  '3feb7d6c3dda338b3fc371fc201e8f743feb4e81b4e81b4f3fc44d2b6ccb7d1e3feb2036406c80d93fc526e5e3a1b438',
  '3feaf286bca1af283fc5ff3070a793d43feac5701ac5701b3fc6d60fe719d21d3fea98ef606a63be3fc7ab890210d909',
  '3fea6d01a6d01a6d3fc87fa06520c9113fea41a41a41a41a3fc9525a9cf456b43fea16d3f97a4b023fca23bc1fe2b563',
  '3fe9ec8e951033d93fcaf3c94e80bff33fe9c2d14ee4a1023fcbc286742d8cd63fe999999999999a3fcc8ff7c79a9a22',
  '3fe970e4f80cb8723fcd5c216b4fbb913fe948b0fcd6e9e03fce27076e2af2e63fe920fb49d0e2293fcef0adcbdc5936',
  '3fe8f9c18f9c18fa3fcfb9186d5e3e2b3fe8d3018d3018d33fd0402594b4d0413fe8acb90f6bf3aa3fd0a324e27390e3',
  '3fe886e5f0abb04a3fd1058bf9ae4ad53fe86186186186183fd1675cababa60e3fe83c977ab2bedd3fd1c898c16999fb',
  '3fe81818181818183fd22941fbcf79663fe7f405fd017f403fd2895a13de86a33fe7d05f417d05f43fd2e8e2bae11d31',
  '3fe7ad2208e0ecc33fd347dd9a987d553fe78a4c8178a4c83fd3a64c556945ea3fe767dce434a9b13fd404308686a7e4',
  '3fe745d1745d17463fd4618bc21c5ec23fe724287f46debc3fd4be5f957778a13fe702e05c0b81703fd51aad872df82d',
  '3fe6e1f76b4337c73fd5767717455a6c3fe6c16c16c16c173fd5d1bdbf5809ca3fe6a13cd15372903fd62c82f2b9c795',
  '3fe68168168168173fd686c81e9b14af3fe661ec6a5122f93fd6e08eaa2ba1e43fe642c8590b21643fd739d7f6bbd007',
  '3fe623fa770162403fd792a55fdd47a23fe60581605816063fd7eaf83b82afc33fe5e75bb8d015e73fd842d1da1e8b17',
  '3fe5c9882b9310573fd89a3386c1425b3fe5ac056b015ac03fd8f11e873662c73fe58ed2308158ed3fd947941c2116fb',
  '3fe571ed3c506b3a3fd99d958117e08b3fe5555555555555bfd269621134db923fe5390948f40febbfd214456d0eb8d4',
  '3fe51d07eae2f815bfd1bf99635a6b953fe5015015015015bfd16b5ccbacfb733fe4e5e0a72f0539bfd1178e8227e47c',
  '3fe4cab88725af6ebfd0c42d676162e33fe4afd6a052bf5bbfd07138604d58623fe49539e3b2d067bfd01eae5626c691',
  '3fe47ae147ae147bbfcf991c6cb3b3793fe460cbc7f5cf9abfcef5ade4dcffe63fe446f86562d9fbbfce530effe71012',
  '3fe42d6625d51f87bfcdb13db0d489403fe4141414141414bfcd1037f2655e7b3fe3fb013fb013fbbfcc6ffbc6f00f71',
  '3fe3e22cbce4a902bfcbd087383bd8ad3fe3c995a47babe7bfcb31d8575bce3d3fe3b13b13b13b14bfca93ed3c8ad9e3',
  '3fe3991c2c187f63bfc9f6c4070896643fe3813813813814bfc95a5adcf7017f3fe3698df3de0748bfc8beafeb38fe8c',
  '3fe3521cfb2b78c1bfc823c16551a3c23fe33ae45b57bcb2bfc7898d85444c733fe323e34a2b10bfbfc6f0128b756abc',
  '3fe30d190130d190bfc6574ebe8c133a3fe2f684bda12f68bfc5bf406b543db23fe2e025c04b8097bfc527e5e4a1b58d',
  '3fe2c9fb4d812ca0bfc4913d8333b5613fe2b404ad012b40bfc3fb45a59928cc3fe29e4129e4129ebfc365fcb0159016',
  '3fe288b01288b013bfc2d1610c86813a3fe27350b8812735bfc23d712a49c2023fe25e22708092f1bfc1aa2b7e23f72a',
  '3fe2492492492492bfc1178e8227e47c3fe23456789abcdfbfc08598b59e3a073fe21fb78121fb78bfbfe89139dbd566',
  '3fe20b470c67c0d9bfbec739830a11203fe1f7047dc11f70bfbda727638446a23fe1e2ef3b3fb874bfbc885801bc4b23',
  '3fe1cf06ada2811dbfbb6ac88dad5b1c3fe1bb4a4046ed29bfba4e7640b1bc383fe1a7b9611a7b96bfb9335e5d594989',
  '3fe19453808ca29cbfb8197e2f40e3f03fe1811811811812bfb700d30aeac0e13fe16e0689427379bfb5e95a4d9791cb',
  '3fe15b1e5f75270dbfb4d3115d207eac3fe1485f0e0acd3bbfb3bdf5a7d1ee643fe135c81135c811bfb2aa04a44717a5',
  '3fe12358e75d3033bfb1973bd14655673fe1111111111111bfb08598b59e3a073fe0fef010fef011bfaeea31c006b87c',
  '3fe0ecf56be69c90bfaccb73cdddb2cc3fe0db20a88f4696bfaaaef2d0fb10fc3fe0c9714fbcda3bbfa894aa149fb343',
  '3fe0b7e6ec259dc8bfa67c94f2d4bb583fe0a6810a6810a7bfa466aed42de3ea3fe0953f39010954bfa252f32f8d183f',
  '3fe0842108421084bfa0415d89e744443fe073260a47f7c6bf9c63d2ec14aaf23fe0624dd2f1a9fcbf98492528c8cabf',
  '3fe05197f7d73404bf9432a925980cc13fe0410410410410bf902056589358473fe03091b51f5e1abf882448a388a2aa',
  '3fe0204081020408bf8010157588de713fe0101010101010bf70080559588b353fe00000000000000000000000000000',
  '0000000000000000bfc714b312ffc98e3fca619f928980a6bfcec709dd391af83fd2776c50e28d61bfd71547652b82c7',
  '3fdec709dc3a04003c5746f307c00c8ebfe71547652b82febc677aa5cbc36d0f3ff71547652b82fe3c7777cbae0ed1aa',
  '000000003ff000000000000000000000bc0ebef93fefc0683f8706adaf949f493bab0b5d3fef81a83f96f6435f8f3269',
  '3c2ec7643fef445d3fa11d9d6edefdb83bbbc33d3fef08713fa6aa8c69f829953b8261bf3feecc323fac4a04287d6529',
  'bb6669b23fee920f3fb0e0c68e424acebc0ca7313fee56ee3fb3add69167a803bc20d8513fee1e523fb6617ac26d3c85',
  'bbc630d63fede50f3fb92246d1c795403b74d1953fedad923fbbd24b77dbb1643c043bb83fed77123fbe7af7c8933e03',
  '3c6e54c13fed411b3fc090e9025eddd43c1ef8a03fed0cfe3fc1db051c140737bc117e843fecd75d3fc33127811d49f6',
  'bc15ffe33feca3c23fc47cbbf2792a043bf265a13fec72bb3fc5b9eaf8e6028b3c423d8f3fec404b3fc70275f1837cd6',
  '3c438f233fec0df83fc84c8ea3631e5b3bca3acf3febdc793fc9937c528da973bb9531f63febac9a3fcad1d89ecd0361',
  '3c6563203feb7d573fcc0e457f1a4606bc0c163d3feb4e233fcd4c6ec7f0fa9bbbba40e13feb20433fce83b51de1e130',
  'bbc7e2273feaf2f43fcfb929fcb47417bc1c14b63feac4f83fd07aa91b2ca2303bd5ff933fea985d3fd1150405368efc',
  '3c1cf38b3fea6c723fd1adfba4172d243c054efc3fea41fc3fd242d294235c3abba4d3ba3fea16133fd2ddbbfb7f3c85',
  'bc5100723fe9ec653fd371b8e9222827bc7cd2013fe9c1f13fd4096a3fa760783bdf75713fe999e13fd49976c7cfb747',
  'bc041a1c3fe971c73fd52a89b6126155bbd3ca043fe9495a3fd5bdb10e1494ce3c039bdd3fe921223fd65101a7359962',
  '3b93fcad3fe8fa0a3fd6e11602431b0e3c3c1b243fe8d2f83fd771f64145b29f3c2f706a3fe8ada33fd7fd3a0cd1729b',
  '3bd918b83fe887a83fd88bc1f2b8fde1bc2608613fe861f53fd91a168bad4093bbfe1d823fe83bac3fd9ab83601c2e99',
  'bc2aee253fe818123fda338d65098fbf3c1a69003fe7f4e73fdabab52f19a9cbbc0f037e3fe7d08a3fdb47463d06a5f0',
  '3c2340b73fe7adab3fdbcedccd4da020bbed72fc3fe78ac83fdc574b4f99ab6dbc2e1aae3fe7674e3fdce2d8491411da',
  'bc5131033fe745163fdd6a3ba17a98bebc118bbe3fe7237e3fddefe824a6fe073c2e68a13fe701f83fde760f0bc2be8b',
  '3c3ea09e3fe6e2c13fdef3a91e17bbc9bc6f56bb3fe6c2403fdf77299fcad5de3c4a86963fe6a1963fdffc0dbd620500',
  'bc25c2883fe6810c3fe04097743d5c6f3c7fac703fe661563fe081d335d14e253c33a9f83fe6421b3fe0c26c86b500df',
  '3c6397df3fe6239f3fe101d26a8d3ec43c4eed683fe6057d3fe140d32757ef1bbbdc85393fe5e6c83fe181602d908fc1',
  '3c257ab03fe5c88f3fe1c1412597d32d3bc639043fe5ac593fe1fd31c7e401e53c5c090a3fe58e2f3fe23d9f51b99eb2',
  '3c167a3e3fe572b03fe278a8c472c40fbbf2e2123fe5552cbfda8f468bea6bab3c50b09f3fe538c4bfda1401a35e2207',
  '3c3d724e3fe51da3bfd99dad548d58543bdb2df33fe5014fbfd9217b478247c63c7dc05c3fe4e5f6bfd8a8f65b8148dc',
  'bc6280263fe4cb44bfd832b8e69895b4bc42ec4d3fe4af97bfd7b78304d092783be07f8f3fe494dfbfd73ff3131de57a',
  '3c5aa8043fe47a6ebfd6c907a7936f76bc23a9d13fe46037bfd6528920cd07753c157e153fe44758bfd5e190433aef0e',
  'bc1c5e8c3fe42d10bfd56998ac049478bc26d1ef3fe414a2bfd4f9884d6cfb2f3c57b5cf3fe3faa2bfd481adba3bc479',
  '3c4c44373fe3e1a4bfd40de517e6879cbc702b7b3fe3c990bfd39dce8d0c6f053c7803ce3fe3b1bbbfd32e56a8c00a1e',
  'bc76ff603fe398b0bfd2b8a31c0111093bd74b4a3fe380a5bfd24714e481adf73bd6010c3fe36a2cbfd1dc7279db548f',
  '3c48b8973fe351dcbfd16889c7153834bc2a84b23fe339e9bfd0f5cd7fa7752cbbd88c373fe323acbfd08ac35435c943',
  'bbc6fbf93fe30c53bfd019dc059d0e543bf111ca3fe2f6dbbfcf6320a3e9eb20bbfb7cc43fe2e05bbfce87862d120f6b',
  'bbc4f1023fe2ca3abfcdae8b05ec16593c056e0a3fe2b461bfccd75698d83d8e3bf96f3e3fe29f22bfcc051d7f25d8c7',
  'bbec0f453fe28808bfcb1f77901c26d4bbf3bc703fe27389bfca52c7fa334e41bbbf1f003fe25d32bfc972ab200ae538',
  'bc6a2c6d3fe249c6bfc8aef62d76aa723c41beab3fe233c6bfc7d04afe225801bc54f6153fe21f57bfc70088de1f5b2d',
  '3c290e853fe20b41bfc6336ad8a92825bba6ad5e3fe1f655bfc55cd01eaa94873bc5753a3fe1e203bfc48b713902f7fe',
  'bbdbbf393fe1ce6ebfc3c0cc1d1b1692bb8ae1d33fe1bb6ebfc2fb577a193876bbd4d76f3fe1a8acbfc2379731e9df8f',
  '3c0bb1b03fe194f0bfc168c50866af193c3a48a53fe18154bfc09a5bcb833e9e3ba5a0983fe16ed7bfbfadd6b7f005b1',
  '3c0b41903fe15b12bfbe0a139ddec9d0bc4080e43fe14803bfbc73a3428818bc3bc9b8cb3fe1358abfbae8051978c11b',
  'bc2d8b833fe12303bfb9598fa7feff2bbba7a1293fe11141bfb7da11dd576bbebbe388f73fe0fe07bfb63919388d8212',
  '3bedc80c3fe0ed3abfb4cb396209a15a3c597adf3fe0da57bfb32e39f0a97dd13bfa2e1c3fe0ca09bfb1c83bbb91b133',
  '3b44b8943fe0b80bbfb03b9bf822af8e3bc4ae6c3fe0a76cbfad977378a15b0cbc473d493fe095ddbfaa8b0f9d7eed2f',
  '3bfc4c603fe084a8bfa78b28a5f18eb0bbc08d1e3fe07294bfa461023c6c2b3f',
);
const COS_P = hx(
  '3ef99169fc938f4abf56c07f16945df43fa55553c7899699bfdffffffcb82e97',
);
const SIN_P = hx(
  'bf29943e0fc4818f3f811073afd145ebbfc555545268a02a',
);
const SC_P = hx(
  'c02c3d3ee4f8713fc020bc0396540c13c02ef09ab49e3a5bc02d6f5ade6c8c373f24bc899499342c3f4d9c364e9721d5',
  '40444921a30f0d80401d78212789bc11406e97264e36bd934062c6b9c7f88fa0',
);

const TWO_OVER_PI = fromBits(0x3fe45f30, 0x6dc9c883);
const PIO2_HI = fromBits(0x3ff921fb, 0x54442d18);
const PIO2_LO = fromBits(0x3c91a626, 0x33145c07);
const SHIFT = fromBits(0x42c80000, 0);
const L2T128 = fromBits(0x407a934f, 0x0979a371);
const P26 = 67108864;
const M26 = f32(1 / 67108864);
/** 2^(k / 128) scaled: table bits + (k << 45) (64-bit integer add), as a double. */
function scale(k: number): number {
  const i = k & 0x7f;
  dv.setFloat64(0, EXP_T[i]);
  let hi = dv.getUint32(0), lo = dv.getUint32(4);
  // k << 45: bits 45..63 -> hi bits 13..31 (k's low 19 bits); lo unaffected
  hi = (hi + ((k << 13) >>> 0)) >>> 0;
  return fromBits(hi, lo);
}

/** Apple exp2f. */
export function exp2f(x: number): number {
  const b = fbits(x);
  if (((b >>> 23) & 0xff) >= 0x87) {
    if (x >= 0 || Number.isNaN(x)) return Number.isNaN(x) ? x : x === 0 ? 1 : Infinity;
    return 0;
  }
  const d0 = x;
  const d2 = d0 + SHIFT;
  const d1 = d2 - SHIFT;
  const k = bitsLo(d2) | 0;
  const r = d0 - d1;
  const c = fmaD(EXP_C[0], r, EXP_C[1]);
  const s = scale(k);
  return f32(fmaD(c * r, s, s));
}

/** Apple __exp10f. */
export function exp10f(x: number): number {
  const b = fbits(x);
  if (((b >>> 23) & 0xff) >= 0x85) {
    if (x >= 0 || Number.isNaN(x)) return Number.isNaN(x) ? x : x === 0 ? 1 : Infinity;
    return 0;
  }
  const d0 = L2T128 * x;
  const d1 = Math.sign(d0) * Math.round(Math.abs(d0));
  const k = d1 | 0;
  const r = d0 - d1;
  const c = fmaD(EXP_C[2], r, EXP_C[3]);
  const s = scale(k);
  return f32(fmaD(c * r, s, s));
}

/** Apple logf (positive normal arguments; others via Math). */
export function logf(x: number): number {
  const w0 = fbits(x);
  if (((w0 - 0x800000) >>> 0) >= 0x7f000000) return f32(Math.log(x));
  const i = (((w0 & 0x7fffff) + 0x8000) >>> 16);
  const m = fromBits(0x3ff00000 | ((w0 & 0x7fffff) >>> 3), ((w0 & 7) << 29) >>> 0);
  const inv = LOG_T[2 * i], lg = LOG_T[2 * i + 1];
  const r = fmaD(m, inv, -1);
  const e = (w0 - 0x3f3f8000) >> 23;
  let d0 = fmaD(e, LOG_C[3], lg);
  const c17 = fmaD(r, LOG_C[0], LOG_C[1]);
  d0 = fmaD(r, LOG_C[2], d0);
  return f32(fmaD(r * r, c17, d0));
}

function cosPoly(r: number): number {
  const d1 = r * r;
  const d3 = fmaD(d1, COS_P[0], COS_P[1]);
  const d5 = fmaD(d1, COS_P[2], COS_P[3]);
  const d2 = d1 * d1;
  return fmaD(d1, fmaD(d2, d3, d5), 1);
}
function sinPoly(r: number): number {
  const d4 = r * r;
  const d5 = r * d4;
  const d17 = fmaD(d4, SIN_P[0], SIN_P[1]);
  const d6 = d4 * d5;
  const d18 = fmaD(d5, SIN_P[2], r);
  return fmaD(d6, d17, d18);
}
/** fcvtns: round to nearest, ties to even. */
function rne(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
function tail(n: number, r: number): number {
  const v = (n & 1) !== 0 ? cosPoly(r) : sinPoly(r);
  return f32((n & 2) !== 0 ? -v : v);
}

/** Apple cosf. */
export function cosf(x: number): number {
  const a = Math.abs(x);
  const w0 = fbits(a);
  if (w0 >= 0x4c800000) return f32(Math.cos(x));
  if (w0 < 0x3f490fdb) {
    if (w0 >= 0x39800000) return f32(cosPoly(a));
    return f32(f32(P26 - a) * M26);
  }
  const d2 = a * TWO_OVER_PI;
  const n = rne(d2);
  let r = fmaD(-n, PIO2_HI, a);
  if (w0 >= 0x42f00000) r = fmaD(-n, PIO2_LO, r);
  return tail(n + 1, r);
}

/** Apple sinf. */
export function sinf(x: number): number {
  const w0 = fbits(x) & 0x7fffffff;
  if (w0 >= 0x4c800000) return f32(Math.sin(x));
  if (w0 < 0x3f490fdb) {
    if (w0 >= 0x39800000) return f32(sinPoly(x));
    return f32(fma32(x, P26, x) * M26);
  }
  const d2 = x * TWO_OVER_PI;
  const n = rne(d2);
  let r = fmaD(-n, PIO2_HI, x);
  if (w0 >= 0x42f00000) r = fmaD(-n, PIO2_LO, r);
  return tail(n, r);
}
const fma32 = (a: number, b: number, c: number): number => f32(a * b + c);

/** Apple __sincosf_stret: [sin, cos] (its own polynomial, not cosf / sinf). */
export function sincosf(x: number, out: number[]): void {
  const a = Math.abs(x);
  const w0 = fbits(a);
  if (w0 >= 0x42f00000 || w0 < 0x39800000) {
    if (w0 < 0x39800000) { out[1] = f32(f32(P26 - a) * M26); out[0] = f32(fma32(x, P26, x) * M26); return; }
    out[0] = f32(Math.sin(x)); out[1] = f32(Math.cos(x)); return;
  }
  const d2 = x * TWO_OVER_PI;
  const n = rne(d2);
  const u = d2 - n;
  const u2 = u * u;
  const a0 = u2 + SC_P[0], a1 = u2 + SC_P[1], b0 = u2 + SC_P[2], b1 = u2 + SC_P[3];
  const p0 = u * SC_P[4], p1 = SC_P[5];
  const q0 = fmaD(u2, a0, SC_P[6]), q1 = fmaD(u2, a1, SC_P[7]);
  const r0 = fmaD(u2, b0, SC_P[8]), r1 = fmaD(u2, b1, SC_P[9]);
  let s = f32((p0 * q0) * r0), c = f32((p1 * q1) * r1);
  if ((n & 2) !== 0) { s = -s; c = -c; }
  if ((n & 1) !== 0) { out[0] = c; out[1] = -s; } else { out[0] = s; out[1] = c; }
}

// ------------------------------------------------------------------ expf
const EXPF_K = fromBits(0x40671547, 0x652b82fe); // 128 / ln 2
const EXPF_SHIFT = fromBits(0x43380000, 0);
/** Apple expf: x 128 / ln 2 rounded (fused shift), 2^(k / 128) from the table, the exp10f quadratic. */
export function expf(x: number): number {
  const b = fbits(x);
  if (((b >>> 23) & 0xff) >= 0x86) {
    if (b >>> 31) return 0;
    return Number.isNaN(x) ? x : Infinity;
  }
  const d1 = fmaD(EXPF_K, x, EXPF_SHIFT);
  const kd = d1 - EXPF_SHIFT;
  const r = fmaD(EXPF_K, x, -kd);
  const c = fmaD(EXP_C[2], r, EXP_C[3]);
  const k = kd | 0;
  const s = scale(k & 127) * Math.pow(2, k >> 7);
  return f32(fmaD(c * r, s, s));
}

// ------------------------------------------------------------------ tanf
const TAN_HI = fromBits(0x3fe45f30, 0x6e000000);
const TAN_LO = fromBits(0xbdfb1bbe, 0xad603d8b);
const TAN_S = hx(
  '3f6fe5da804efbdc3f51e9c887f6c8a13f8487da95c9f1733f961eb51f86747c3faba586a7f44ae73fc1110746e09b07',
  '3fd555555d8d8930',
);
const TAN_P = hx(
  '40151d4a014005d8400e91f74c2eeaabbfd609394a49adf1bff88f856cde0b643fed3764811481d23fe81ba4203c502d',
  '3fedb0d5be6b368b3fe2d17a5cc6b70b',
);
/** Apple tanf (|x| < 2^26: an odd polynomial below pi / 4, else a rational form in quarter periods). */
export function tanf(x: number): number {
  const w = fbits(x) & 0x7fffffff;
  if (w >= 0x4c800000) return w >= 0x7f800000 ? NaN : f32(Math.tan(x));
  if (w < 0x3f490fdb) {
    if (w < 0x39800000) return x;
    const z = x * x;
    let d6 = fmaD(z, TAN_S[1], TAN_S[2]);
    const d16 = fmaD(z, TAN_S[3], TAN_S[4]);
    let d18 = fmaD(z, TAN_S[5], TAN_S[6]);
    let z2 = z * z;
    d6 = fmaD(z2, TAN_S[0], d6);
    d18 = fmaD(z2, d16, d18);
    z2 = z2 * z2;
    d18 = fmaD(z2, d6, d18);
    return f32(fmaD(x, z * d18, x));
  }
  const q = x * TAN_HI;
  const n = rne(q);
  const r = fmaD(x, TAN_LO, q - n);
  const z = r * r;
  const d5 = r * fmaD(z, TAN_P[0], TAN_P[1]);
  const d17 = fmaD(z, z + TAN_P[2], TAN_P[5]);
  const d18 = fmaD(z, z + TAN_P[3], TAN_P[6]);
  const d19 = fmaD(z, z + TAN_P[4], TAN_P[7]);
  let y = (d5 * d17) * (d18 * d19);
  if (n % 2 !== 0) y = -1 / y;
  return f32(y);
}

// ------------------------------------------------------------------ powf
// Apple powf (copied from the BooBass / Drumpad port, src/engine/gen/plugins/drumpad/libm.ts):
// 2^(y log2 x), log2 from a 128-entry table and a quartic (scaled by 128), exp2 from the
// 2^(j / 128) table and the quadratic above, in double, rounded to float once.
const POW_INVC = new Float64Array(128);
const POW_LOGC = new Float64Array(128);
{
  for (let i = 0; i < 128; i++) {
    fbuf.setUint32(0, 0x3f338000 + (i << 16) + 0x8000);
    const c = fbuf.getFloat32(0);
    POW_INVC[i] = 1 / c;
    POW_LOGC[i] = Math.log2(c) * 128;
  }
}
const PA = -46.16680486880053, PB = 61.55555197023551, PC = -92.33248261492298, PD = 184.6649652327124;
/** Apple powf for x > 0 (x = 0: 0 for y > 0); other inputs fall back to Math.pow. */
export function powf(x: number, y: number): number {
  x = f32(x); y = f32(y);
  if (x === 1) return 1;
  if (y === 1) return x;
  const ix = fbits(x), iy = fbits(y);
  if (((iy & 0x7fffffff) - 1) >>> 0 >= 0x7f7fffff || ((ix - 0x800000) >>> 0) >= 0x7f000000) {
    if (x === 0 && y > 0) return 0;
    return f32(Math.pow(x, y));
  }
  const tmp = (ix - 0x3f338000) | 0;
  const i = (tmp >>> 16) & 127;
  const top = tmp & 0xff800000;
  fbuf.setUint32(0, (ix - top) >>> 0);
  const z = fbuf.getFloat32(0);
  const r = fmaD(z, POW_INVC[i], -1);
  const y0 = POW_LOGC[i] + (top >> 16);
  const r2 = r * r;
  const p = fmaD(fmaD(r, PA, PB), r2, fmaD(r, PC, PD));
  const l = fmaD(p, r, y0);
  let t = y * l;
  t = t < 32768 ? t : 32768;
  t = t > -32768 ? t : -32768;
  const ki = t < 0 ? -Math.round(-t) : Math.round(t);
  const rr = t - ki;
  const s = scale(ki & 127) * Math.pow(2, ki >> 7);
  const e = fmaD(EXP_C[2], rr, EXP_C[3]) * rr;
  return f32(fmaD(e, s, s));
}
