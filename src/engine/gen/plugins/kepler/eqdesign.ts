// Kepler Exo equalizer band designer (engine.dylib 0x32048, the three filter types the EQ uses: codes 5 / 6 / 8).
// Input: gain in dB, the centre / corner frequency normalised to the Nyquist frequency (f * 2 / sr), Q; output: the
// five coefficients of one biquad (a1, a2, b0, b1, b2: y = b0 x + b1 x1 + b2 x2 - a1 y1 - a2 y2) in double precision.
// The design is an analog-matched parametric EQ with closed-form coefficients (a "peaking" type 6 and low / high shelf
// types 5 / 8, each with a normal branch, a low-Q branch and a branch for corner frequencies above the Nyquist
// frequency). The code below is a mechanical transcription of FL's arm64 routine (tools/a2c.py): the statements keep
// FL's operation order, fused multiply-adds (fmaD) and libm calls, so the coefficients agree with FL's to the last
// bits of the doubles that FL converts to single precision (checked on 120000 designs: no single-precision difference).
// The labels are FL's code addresses.

import { fmaD } from './fmath';

const fminnm = (a: number, b: number): number => (a !== a ? b : b !== b ? a : Math.min(a, b));
const fmaxnm = (a: number, b: number): number => (a !== a ? b : b !== b ? a : Math.max(a, b));

/** FL's filter code for the EQ band types (low shelf, peak, high shelf). */
export const EQ_CODES = [5, 6, 8];
const ENTRY: Record<number, number> = { 5: 0x3240c, 6: 0x325fc, 8: 0x328cc };

/** Designs a band into `out` = [a1, a2, b0, b1, b2]. `code` is 5, 6 or 8. */
export function designEqBand(code: number, w: number, Q: number, gainDb: number, out: Float64Array): void {
  const G = Math.pow(10, gainDb / 20);
  const pc0 = ENTRY[code];
  let v0 = 0, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0, v6 = 0, v7 = 0, v11 = 0, v12 = 0, v13 = 0, v14 = 0, v15 = 0, v16 = 0, v17 = 0;
  let x8 = 0;
  let cA = 0, cB = 0;
  let s8 = 0, s16 = 0, s24 = 0, s32 = 0, s40 = 0, s48 = 0, s56 = 0;
  let o1 = 0, o2 = 0, o3 = 0, o4 = 0, o5 = 0;
  let v8 = G;
  let v9 = w;
  let v10 = Q;
  let pc = pc0;
  for (;;) {
    switch (pc) {
    case 0x3240c:
      v0 = -1.0;  // 3240c
      v4 = v8 + v0;  // 32410
      v0 = Math.abs(v4);  // 32414
      v1 = 0.001; // @bfb50  // 3241c
      cA = v0; cB = v1;  // 32420
      if (cA < cB) { pc = 0x328e8; continue; }  // 32424
      v0 = 1.0;  // 32428
      v1 = v0 / v8;  // 3242c
      cA = v8; cB = v1;  // 32430
      v1 = cA < cB ? v1 : v8;  // 32434
      v2 = Math.sqrt(v1);  // 32438
      cA = v1; cB = 0;  // 3243c
      v7 = 0;  // 32440
      v14 = !(cA <= cB) ? v2 : v7;  // 32444
      v12 = v10 * v10;  // 32448
      v6 = v0 / v12;  // 3244c
      v1 = Math.sqrt(v14);  // 32450
      cA = v14; cB = 0;  // 32454
      v1 = !(cA <= cB) ? v1 : v7;  // 32458
      v5 = v1 * v9;  // 3245c
      v3 = v5 * v5;  // 32460
      v2 = v14 * v14;  // 32464
      v3 = v3 / v2;  // 32468
      v17 = fmaxnm(v8, v0);  // 3246c
      v15 = v17 * v3;  // 32470
      v16 = fminnm(v8, v0);  // 32474
      v11 = v3 / v16;  // 32478
      v3 = v8 * v8;  // 3247c
      v13 = v0 / v3;  // 32480
      v3 = 0.6; // @bfb58  // 32488
      cA = v12; cB = v3;  // 3248c
      if (!(cA > cB)) { pc = 0x32f58; continue; }  // 32490
      s16 = v17;  // 32494
      s24 = v16;  // 32494
      v1 = -2.0;  // 32498
      v1 = v6 + v1;  // 3249c
      v0 = v2 + v0;  // 324a0
      v0 = -v0;  // 324a4
      s40 = v4;  // 324a8
      s48 = v1;  // 324a8
      v1 = v1 * v14;  // 324ac
      v0 = v0 / v1;  // 324b0
      v1 = v0 * v0;  // 324b4
      v2 = -1.0;  // 324b8
      v1 = v1 + v2;  // 324bc
      v2 = Math.sqrt(v1);  // 324c0
      cA = v1; cB = 0;  // 324c4
      v1 = !(cA <= cB) ? v2 : v7;  // 324c8
      v9 = v0 - v1;  // 324cc
      v1 = v9 / v14;  // 324d0
      v0 = Math.sqrt(v1);  // 324d4
      s8 = v1;  // 324d8
      cA = v1; cB = 0;  // 324dc
      v0 = !(cA <= cB) ? v0 : v7;  // 324e0
      s32 = v5;  // 324e4
      v10 = v5 * v0;  // 324e8
      v0 = 1.5707963267948966; // @bf838  // 324f0
      s56 = v0;  // 324f4
      v0 = v10 * v0;  // 324f8
      v0 = Math.sin(v0);  // 324fc
      v5 = v0 * v0;  // 32500
      v0 = v10 * v10;  // 32504
      v1 = v15 - v0;  // 32508
      v1 = v1 * v1;  // 3250c
      v2 = v15 * v0;  // 32510
      v1 = fmaD(v12, v1, v2);  // 32514
      v1 = v13 * v1;  // 32518
      v2 = v11 - v0;  // 3251c
      v2 = v2 * v2;  // 32520
      v0 = v11 * v0;  // 32524
      v0 = fmaD(v12, v2, v0);  // 32528
      v2 = v9;  // 3252c
      v0 = v1 / v0;  // 32530
      v1 = v10;  // 32534
      cA = v10; cB = v9;  // 32538
      v4 = v15;  // 3253c
      if (!(cA < cB)) { pc = 0x3329c; continue; }  // 32540
      v9 = v1 / v2;  // 32544
      v14 = v0;  // 32548
      v0 = s56;  // 3254c
      v0 = v9 * v0;  // 32550
      v10 = v11;  // 32554
      v11 = v4;  // 32558
      v15 = v5;  // 3255c
      v0 = Math.sin(v0);  // 32560
      v2 = v0 * v0;  // 32564
      v0 = v9 * v9;  // 32568
      v1 = v11 - v0;  // 3256c
      v1 = v1 * v1;  // 32570
      v3 = v11 * v0;  // 32574
      v1 = fmaD(v12, v1, v3);  // 32578
      v1 = v13 * v1;  // 3257c
      v3 = v10 - v0;  // 32580
      v3 = v3 * v3;  // 32584
      v0 = v10 * v0;  // 32588
      v0 = fmaD(v12, v3, v0);  // 3258c
      v0 = v1 / v0;  // 32590
      v1 = -1.0;  // 32594
      v3 = v0 + v1;  // 32598
      v4 = v14 + v1;  // 3259c
      v5 = -v4;  // 325a0
      v1 = v2 * v5;  // 325a4
      v1 = fmaD(v3, v15, v1);  // 325a8
      v6 = -2.0;  // 325ac
      v1 = v1 * v6;  // 325b0
      v6 = v0 - v14;  // 325b4
      v0 = v15 * v6;  // 325b8
      v0 = v2 * v0;  // 325bc
      v1 = v1 / v0;  // 325c0
      v0 = v4 + v4;  // 325c4
      v0 = v0 / v15;  // 325c8
      v0 = fmaD(v14, v1, v0);  // 325cc
      v4 = v15 * v15;  // 325d0
      v7 = v2 * v2;  // 325d4
      v7 = v7 * v5;  // 325d8
      v3 = fmaD(v3, v4, v7);  // 325dc
      v2 = v15 * v2;  // 325e0
      v2 = v2 * v2;  // 325e4
      v2 = v2 * v6;  // 325e8
      v2 = v3 / v2;  // 325ec
      v3 = v5 / v4;  // 325f0
      v3 = fmaD(v14, v2, v3);  // 325f4
      pc = 0x337ec; continue;  // 325f8
    case 0x325fc:
      v0 = -1.0;  // 325fc
      v0 = v8 + v0;  // 32600
      v0 = Math.abs(v0);  // 32604
      v1 = 0.001; // @bfb50  // 3260c
      cA = v0; cB = v1;  // 32610
      if (cA < cB) { pc = 0x328e8; continue; }  // 32614
      v15 = v10 * v10;  // 32618
      v11 = 1.0;  // 3261c
      v12 = v9 * v9;  // 32620
      cA = v9; cB = v11;  // 32624
      v13 = v11 / v15;  // 32628
      if (!(cA < cB)) { pc = 0x33038; continue; }  // 3262c
      v14 = v8 * v8;  // 32630
      v0 = 1.5707963267948966; // @bf838  // 32638
      s56 = v0;  // 3263c
      v0 = v9 * v0;  // 32640
      v0 = Math.sin(v0);  // 32644
      v11 = v0 * v0;  // 32648
      v0 = v9 * v10;  // 3264c
      v1 = 0.5;  // 32650
      v1 = v15 + v1;  // 32654
      v2 = 0.25;  // 32658
      v2 = v15 + v2;  // 3265c
      v3 = Math.sqrt(v2);  // 32660
      cA = v2; cB = 0;  // 32664
      v2 = 0;  // 32668
      v3 = !(cA <= cB) ? v3 : v2;  // 3266c
      v1 = v1 + v3;  // 32670
      v3 = Math.sqrt(v1);  // 32674
      cA = v1; cB = 0;  // 32678
      v1 = !(cA <= cB) ? v3 : v2;  // 3267c
      v0 = v0 / v1;  // 32680
      v1 = s56;  // 32684
      v0 = v0 * v1;  // 32688
      v0 = Math.sin(v0);  // 3268c
      v0 = v0 * v0;  // 32690
      v1 = -1.0;  // 32694
      v2 = v12 + v1;  // 32698
      v2 = v2 * v2;  // 3269c
      v3 = v12 * v8;  // 326a0
      v3 = fmaD(v3, v13, v2);  // 326a4
      v4 = v12 * v13;  // 326a8
      v4 = v4 / v8;  // 326ac
      v2 = v2 + v4;  // 326b0
      v2 = v3 / v2;  // 326b4
      v17 = 1.0;  // 326b8
      v3 = v17 - v8;  // 326bc
      v3 = v3 / v0;  // 326c0
      v4 = v17 - v14;  // 326c4
      v5 = v4 / v11;  // 326c8
      v6 = v0 / v11;  // 326cc
      v7 = -2.0;  // 326d0
      v6 = v6 + v7;  // 326d4
      v3 = fmaD(v5, v6, v3);  // 326d8
      v6 = v8 - v14;  // 326dc
      v3 = v3 / v6;  // 326e0
      v6 = v17 - v2;  // 326e4
      v16 = v17 / v11;  // 326e8
      v7 = v16 + v7;  // 326ec
      v5 = fmaD(v5, v7, v6);  // 326f0
      v2 = v2 - v14;  // 326f4
      v2 = v5 / v2;  // 326f8
      v2 = v2 - v3;  // 326fc
      v5 = v17 - v0;  // 32700
      v6 = 1.0;  // 32704
      v5 = v2 / v5;  // 32708
      v0 = fmaD(-v0, v5, v3);  // 3270c
      v1 = v14 + v1;  // 32710
      v1 = v1 + v1;  // 32714
      v1 = v1 / v11;  // 32718
      v1 = fmaD(v14, v0, v1);  // 3271c
      v2 = v11 * v11;  // 32720
      v2 = v4 / v2;  // 32724
      v3 = fmaD(v14, v5, v2);  // 32728
      v0 = v0 + v6;  // 3272c
      v2 = v5 + v0;  // 32730
      v4 = -0.25;  // 32734
      v0 = v5 * v4;  // 32738
      v1 = v1 + v6;  // 3273c
      v1 = v3 + v1;  // 32740
      v9 = v3 * v4;  // 32744
      pc = 0x330ec; continue;  // 32748
    case 0x328cc:
      v0 = -1.0;  // 328cc
      v0 = v8 + v0;  // 328d0
      v0 = Math.abs(v0);  // 328d4
      v1 = 0.001; // @bfb50  // 328dc
      cA = v0; cB = v1;  // 328e0
      if (!(cA < cB)) { pc = 0x32c44; continue; }  // 328e4
      pc = 0x328e8; continue;  // fall through
    case 0x328e8:
      x8 = 4607182418800017408;  // 328e8
      o3 = 1.0;  // 328ec
      o2 = 0;  // 328f0
      o1 = 0;  // 328f4
      o5 = 0;  // 328f8
      o4 = 0;  // 328fc
      pc = 0x33a7c; continue;  // 32900
    case 0x32c44:
      v0 = 1.0;  // 32c44
      v1 = v0 / v8;  // 32c48
      cA = v8; cB = v1;  // 32c4c
      v1 = cA < cB ? v1 : v8;  // 32c50
      v2 = Math.sqrt(v1);  // 32c54
      cA = v1; cB = 0;  // 32c58
      v4 = 0;  // 32c5c
      v13 = !(cA <= cB) ? v2 : v4;  // 32c60
      v11 = v10 * v10;  // 32c64
      v5 = v0 / v11;  // 32c68
      v1 = Math.sqrt(v13);  // 32c6c
      cA = v13; cB = 0;  // 32c70
      v1 = !(cA <= cB) ? v1 : v4;  // 32c74
      v15 = v9 / v1;  // 32c78
      v2 = v15 * v15;  // 32c7c
      v6 = fminnm(v8, v0);  // 32c80
      v9 = v2 / v6;  // 32c84
      v7 = fmaxnm(v8, v0);  // 32c88
      v12 = v7 * v2;  // 32c8c
      v3 = v8 * v8;  // 32c90
      v2 = 0.6; // @bfb58  // 32c98
      cA = v11; cB = v2;  // 32c9c
      if (!(cA > cB)) { pc = 0x331b8; continue; }  // 32ca0
      s24 = v7;  // 32ca4
      s32 = v6;  // 32ca4
      v1 = -2.0;  // 32ca8
      v2 = v5 + v1;  // 32cac
      v1 = v13 * v13;  // 32cb0
      v0 = v1 + v0;  // 32cb4
      v0 = -v0;  // 32cb8
      s40 = v2;  // 32cbc
      v1 = v2 * v13;  // 32cc0
      v0 = v0 / v1;  // 32cc4
      v1 = v0 * v0;  // 32cc8
      v2 = -1.0;  // 32ccc
      v1 = v1 + v2;  // 32cd0
      v2 = Math.sqrt(v1);  // 32cd4
      cA = v1; cB = 0;  // 32cd8
      v1 = !(cA <= cB) ? v2 : v4;  // 32cdc
      v0 = v0 - v1;  // 32ce0
      s56 = v0;  // 32ce4
      v0 = v13 * v0;  // 32ce8
      v1 = Math.sqrt(v0);  // 32cec
      cA = v0; cB = 0;  // 32cf0
      v0 = !(cA <= cB) ? v1 : v4;  // 32cf4
      v14 = v15 * v0;  // 32cf8
      v0 = 1.5707963267948966; // @bf838  // 32d00
      s48 = v0;  // 32d04
      v0 = v14 * v0;  // 32d08
      v10 = v3;  // 32d0c
      v0 = Math.sin(v0);  // 32d10
      v3 = v10;  // 32d14
      v4 = v0 * v0;  // 32d18
      v0 = v14 * v14;  // 32d1c
      v1 = v9 - v0;  // 32d20
      v1 = v1 * v1;  // 32d24
      v2 = v9 * v0;  // 32d28
      v1 = fmaD(v11, v1, v2);  // 32d2c
      v1 = v10 * v1;  // 32d30
      v2 = v12 - v0;  // 32d34
      v2 = v2 * v2;  // 32d38
      v10 = v12;  // 32d3c
      v0 = v12 * v0;  // 32d40
      v0 = fmaD(v11, v2, v0);  // 32d44
      v2 = s56;  // 32d48
      v0 = v1 / v0;  // 32d4c
      v1 = v14;  // 32d50
      cA = v14; cB = v2;  // 32d54
      if (!(cA < cB)) { pc = 0x334d8; continue; }  // 32d58
      v8 = v1 / v2;  // 32d5c
      v13 = v0;  // 32d60
      v0 = s48;  // 32d64
      v0 = v8 * v0;  // 32d68
      v12 = v3;  // 32d6c
      v14 = v4;  // 32d70
      v0 = Math.sin(v0);  // 32d74
      v2 = v0 * v0;  // 32d78
      v0 = v8 * v8;  // 32d7c
      v1 = v9 - v0;  // 32d80
      v1 = v1 * v1;  // 32d84
      v3 = v9 * v0;  // 32d88
      v1 = fmaD(v11, v1, v3);  // 32d8c
      v1 = v12 * v1;  // 32d90
      v3 = v10 - v0;  // 32d94
      v3 = v3 * v3;  // 32d98
      v0 = v10 * v0;  // 32d9c
      v0 = fmaD(v11, v3, v0);  // 32da0
      v0 = v1 / v0;  // 32da4
      v1 = -1.0;  // 32da8
      v3 = v0 + v1;  // 32dac
      v4 = v13 + v1;  // 32db0
      v5 = -v4;  // 32db4
      v1 = v2 * v5;  // 32db8
      v1 = fmaD(v3, v14, v1);  // 32dbc
      v6 = -2.0;  // 32dc0
      v1 = v1 * v6;  // 32dc4
      v6 = v0 - v13;  // 32dc8
      v0 = v14 * v6;  // 32dcc
      v0 = v2 * v0;  // 32dd0
      v1 = v1 / v0;  // 32dd4
      v0 = v4 + v4;  // 32dd8
      v0 = v0 / v14;  // 32ddc
      v0 = fmaD(v13, v1, v0);  // 32de0
      v4 = v14 * v14;  // 32de4
      v7 = v2 * v2;  // 32de8
      v7 = v7 * v5;  // 32dec
      v3 = fmaD(v3, v4, v7);  // 32df0
      v2 = v14 * v2;  // 32df4
      v2 = v2 * v2;  // 32df8
      v2 = v2 * v6;  // 32dfc
      v2 = v3 / v2;  // 32e00
      v3 = v5 / v4;  // 32e04
      v3 = fmaD(v13, v2, v3);  // 32e08
      pc = 0x33990; continue;  // 32e0c
    case 0x32f58:
      s40 = v6;  // 32f58
      v0 = v5 / v1;  // 32f5c
      v1 = 0.2; // @bfb60  // 32f64
      v9 = fminnm(v0, v1);  // 32f68
      v14 = 1.5707963267948966; // @bf838  // 32f70
      v0 = v9 * v14;  // 32f74
      v0 = Math.sin(v0);  // 32f78
      v3 = v0 * v0;  // 32f7c
      v0 = v9 * v9;  // 32f80
      v1 = v15 - v0;  // 32f84
      v1 = v1 * v1;  // 32f88
      v2 = v15 * v0;  // 32f8c
      v1 = fmaD(v12, v1, v2);  // 32f90
      v1 = v13 * v1;  // 32f94
      v2 = v11 - v0;  // 32f98
      v2 = v2 * v2;  // 32f9c
      v0 = v11 * v0;  // 32fa0
      v0 = fmaD(v12, v2, v0);  // 32fa4
      v0 = v1 / v0;  // 32fa8
      s48 = v0;  // 32fac
      s56 = v3;  // 32fac
      v0 = -1.0;  // 32fb0
      v1 = v15 + v0;  // 32fb4
      v1 = v1 * v1;  // 32fb8
      v1 = fmaD(v12, v1, v15);  // 32fbc
      v1 = v13 * v1;  // 32fc0
      v0 = v11 + v0;  // 32fc4
      v0 = v0 * v0;  // 32fc8
      v0 = fmaD(v12, v0, v11);  // 32fcc
      v12 = v1 / v0;  // 32fd0
      v0 = Math.sqrt(v11);  // 32fd4
      v0 = v0 * v14;  // 32fd8
      cA = v11; cB = 0;  // 32fdc
      v1 = 0;  // 32fe0
      v15 = !(cA <= cB) ? v0 : v1;  // 32fe4
      v0 = -v15;  // 32fe8
      v0 = v0 / v10;  // 32fec
      v0 = Math.exp(v0);  // 32ff0
      v9 = v0;  // 32ff4
      v0 = -2.0;  // 32ff8
      v13 = v9 * v0;  // 32ffc
      v0 = 0.5;  // 33000
      cA = v10; cB = v0;  // 33004
      if (!(cA > cB)) { pc = 0x33430; continue; }  // 33008
      v0 = 4.0;  // 3300c
      v1 = s40;  // 33010
      v0 = v0 - v1;  // 33014
      v1 = Math.sqrt(v0);  // 33018
      cA = v0; cB = 0;  // 3301c
      v0 = 0;  // 33020
      v0 = !(cA <= cB) ? v1 : v0;  // 33024
      v0 = v0 * v15;  // 33028
      v0 = Math.cos(v0);  // 3302c
      v0 = v0 * v13;  // 33030
      pc = 0x33458; continue;  // 33034
    case 0x33038:
      v0 = 0.5;  // 33038
      v0 = v15 + v0;  // 3303c
      v1 = 0.25;  // 33040
      v1 = v15 + v1;  // 33044
      v2 = Math.sqrt(v1);  // 33048
      cA = v1; cB = 0;  // 3304c
      v9 = 0;  // 33050
      v1 = !(cA <= cB) ? v2 : v9;  // 33054
      v0 = v0 + v1;  // 33058
      v1 = Math.sqrt(v0);  // 3305c
      cA = v0; cB = 0;  // 33060
      v0 = !(cA <= cB) ? v1 : v9;  // 33064
      v10 = v10 / v0;  // 33068
      v0 = 1.5707963267948966; // @bf838  // 33070
      v0 = v10 * v0;  // 33074
      v0 = Math.sin(v0);  // 33078
      v0 = v0 * v0;  // 3307c
      v1 = v10 * v10;  // 33080
      v2 = v12 - v1;  // 33084
      v2 = v2 * v2;  // 33088
      v1 = v12 * v1;  // 3308c
      v3 = v1 * v8;  // 33090
      v3 = fmaD(v3, v13, v2);  // 33094
      v1 = v13 * v1;  // 33098
      v1 = v1 / v8;  // 3309c
      v1 = v2 + v1;  // 330a0
      v1 = v3 / v1;  // 330a4
      v2 = -1.0;  // 330a8
      v3 = v12 + v2;  // 330ac
      v3 = v3 * v3;  // 330b0
      v4 = v12 * v8;  // 330b4
      v4 = fmaD(v4, v13, v3);  // 330b8
      v5 = v12 * v13;  // 330bc
      v5 = v5 / v8;  // 330c0
      v3 = v3 + v5;  // 330c4
      v3 = v4 / v3;  // 330c8
      v2 = v1 + v2;  // 330cc
      v4 = v11 - v0;  // 330d0
      v2 = v4 * v2;  // 330d4
      v1 = v3 - v1;  // 330d8
      v0 = v0 * v1;  // 330dc
      v2 = v2 / v0;  // 330e0
      v1 = v3 * v2;  // 330e4
      v0 = 0;  // 330e8
      pc = 0x330ec; continue;  // fall through
    case 0x330ec:
      v3 = Math.sqrt(v2);  // 330ec
      cA = v2; cB = 0;  // 330f0
      v2 = 0;  // 330f4
      v3 = !(cA <= cB) ? v3 : v2;  // 330f8
      v4 = 1.0;  // 330fc
      v5 = v3 + v4;  // 33100
      v6 = 0.5;  // 33104
      v5 = v5 * v6;  // 33108
      v7 = Math.sqrt(v1);  // 3310c
      cA = v1; cB = 0;  // 33110
      v1 = !(cA <= cB) ? v7 : v2;  // 33114
      v7 = v1 + v4;  // 33118
      v6 = v7 * v6;  // 3311c
      v7 = fmaD(v5, v5, v0);  // 33120
      v16 = Math.sqrt(v7);  // 33124
      cA = v7; cB = 0;  // 33128
      v7 = !(cA <= cB) ? v16 : v2;  // 3312c
      v5 = v5 + v7;  // 33130
      v5 = v4 / v5;  // 33134
      v3 = v4 - v3;  // 33138
      o1 = v3;  // 3313c
      v0 = -v0;  // 33140
      v0 = v5 * v0;  // 33144
      o2 = v0;  // 33148
      v0 = fmaD(v6, v6, v9);  // 3314c
      v3 = Math.sqrt(v0);  // 33150
      cA = v0; cB = 0;  // 33154
      v0 = !(cA <= cB) ? v3 : v2;  // 33158
      v0 = v6 + v0;  // 3315c
      o3 = v0;  // 33160
      v0 = v4 - v1;  // 33164
      o4 = v0;  // 33168
      v0 = -v9;  // 3316c
      v1 = o3;  // 33170
      v0 = v0 / v1;  // 33174
      o5 = v0;  // 33178
      v0 = o3;  // 3317c
      v0 = v0 * v5;  // 33180
      o3 = v0;  // 33184
      v0 = o4;  // 33188
      v0 = v0 * v5;  // 3318c
      o4 = v0;  // 33190
      v0 = o5;  // 33194
      v0 = v5 * v0;  // 33198
      o5 = v0;  // 3319c
      v0 = o1;  // 331a0
      v0 = v5 * v0;  // 331a4
      o1 = v0;  // 331a8
      v0 = o2;  // 331ac
      v0 = v5 * v0;  // 331b0
      pc = 0x33a78; continue;  // 331b4
    case 0x331b8:
      s48 = v5;  // 331b8
      v0 = v1 * v15;  // 331bc
      v1 = 0.2; // @bfb60  // 331c4
      v8 = fminnm(v0, v1);  // 331c8
      v13 = 1.5707963267948966; // @bf838  // 331d0
      v0 = v8 * v13;  // 331d4
      v14 = v3;  // 331d8
      v0 = Math.sin(v0);  // 331dc
      v0 = v0 * v0;  // 331e0
      s56 = v0;  // 331e4
      v0 = v8 * v8;  // 331e8
      v1 = v9 - v0;  // 331ec
      v1 = v1 * v1;  // 331f0
      v2 = v9 * v0;  // 331f4
      v1 = fmaD(v11, v1, v2);  // 331f8
      v1 = v14 * v1;  // 331fc
      v2 = v12 - v0;  // 33200
      v2 = v2 * v2;  // 33204
      v0 = v12 * v0;  // 33208
      v0 = fmaD(v11, v2, v0);  // 3320c
      v15 = v1 / v0;  // 33210
      v0 = -1.0;  // 33214
      v1 = v9 + v0;  // 33218
      v1 = v1 * v1;  // 3321c
      v1 = fmaD(v11, v1, v9);  // 33220
      v1 = v14 * v1;  // 33224
      v0 = v12 + v0;  // 33228
      v0 = v0 * v0;  // 3322c
      v0 = fmaD(v11, v0, v12);  // 33230
      v11 = v1 / v0;  // 33234
      v0 = Math.sqrt(v12);  // 33238
      v0 = v0 * v13;  // 3323c
      cA = v12; cB = 0;  // 33240
      v1 = 0;  // 33244
      v13 = !(cA <= cB) ? v0 : v1;  // 33248
      v0 = -v13;  // 3324c
      v0 = v0 / v10;  // 33250
      v0 = Math.exp(v0);  // 33254
      v8 = v0;  // 33258
      v0 = -2.0;  // 3325c
      v12 = v8 * v0;  // 33260
      v0 = 0.5;  // 33264
      cA = v10; cB = v0;  // 33268
      if (!(cA > cB)) { pc = 0x33670; continue; }  // 3326c
      v0 = 4.0;  // 33270
      v1 = s48;  // 33274
      v0 = v0 - v1;  // 33278
      v1 = Math.sqrt(v0);  // 3327c
      cA = v0; cB = 0;  // 33280
      v0 = 0;  // 33284
      v0 = !(cA <= cB) ? v1 : v0;  // 33288
      v0 = v0 * v13;  // 3328c
      v0 = Math.cos(v0);  // 33290
      v0 = v0 * v12;  // 33294
      pc = 0x33698; continue;  // 33298
    case 0x3329c:
      v7 = s56;  // 3329c
      v6 = 1.0;  // 332a0
      cA = v1; cB = v6;  // 332a4
      if (!(cA < cB)) { pc = 0x33718; continue; }  // 332a8
      v17 = s8;  // 332ac
      v6 = s16;  // 332ac
      v14 = v6 * v17;  // 332b0
      v9 = v2 * v2;  // 332b4
      s32 = v0;  // 332b8
      v0 = v2 * v7;  // 332bc
      v6 = s24;  // 332c0
      v10 = v17 / v6;  // 332c4
      s16 = v11;  // 332c8
      s24 = v1;  // 332c8
      v15 = v4;  // 332cc
      s56 = v5;  // 332d0
      v11 = v2;  // 332d4
      v0 = Math.sin(v0);  // 332d8
      v0 = v0 * v0;  // 332dc
      v1 = v14 - v9;  // 332e0
      v1 = v1 * v1;  // 332e4
      v2 = v9 * v14;  // 332e8
      v1 = fmaD(v12, v1, v2);  // 332ec
      v1 = v13 * v1;  // 332f0
      v2 = v10 - v9;  // 332f4
      v2 = v2 * v2;  // 332f8
      v3 = v9 * v10;  // 332fc
      v2 = fmaD(v12, v2, v3);  // 33300
      v1 = v1 / v2;  // 33304
      v9 = -1.0;  // 33308
      v2 = v14 + v9;  // 3330c
      v2 = v2 * v2;  // 33310
      v2 = fmaD(v12, v2, v14);  // 33314
      v2 = v13 * v2;  // 33318
      v3 = v10 + v9;  // 3331c
      v3 = v3 * v3;  // 33320
      v3 = fmaD(v12, v3, v10);  // 33324
      v2 = v2 / v3;  // 33328
      v10 = -2.0;  // 3332c
      v0 = v10 / v0;  // 33330
      v3 = 2.0;  // 33334
      v0 = v0 + v3;  // 33338
      v3 = v2 + v9;  // 3333c
      v0 = v0 * v3;  // 33340
      v3 = v1 + v9;  // 33344
      v0 = v3 * v0;  // 33348
      v1 = v2 - v1;  // 3334c
      v0 = v0 / v1;  // 33350
      v1 = 0.4052847345693511; // @bfb68  // 33358
      v2 = s48;  // 3335c
      v14 = v2 * v1;  // 33360
      v1 = s40;  // 33364
      v1 = v1 * v14;  // 33368
      v2 = Math.sqrt(v8);  // 3336c
      cA = v8; cB = 0;  // 33370
      v3 = 0;  // 33374
      v2 = !(cA <= cB) ? v2 : v3;  // 33378
      v2 = v2 * v11;  // 3337c
      v1 = v1 / v2;  // 33380
      v0 = v0 / v1;  // 33384
      v0 = Math.log(v0);  // 33388
      s48 = v0;  // 3338c
      v0 = v11;  // 33390
      v0 = Math.log(v0);  // 33394
      v1 = s48;  // 33398
      v1 = v1 / v0;  // 3339c
      v3 = s16;  // 333a0
      v0 = v15 - v3;  // 333a4
      v0 = v0 * v14;  // 333a8
      v2 = v3 * v15;  // 333ac
      v14 = v3;  // 333b0
      v11 = v0 / v2;  // 333b4
      v0 = s24;  // 333b8
      v0 = Math.pow(v0, v1);  // 333bc
      v0 = v11 * v0;  // 333c0
      v1 = v15 + v9;  // 333c4
      v1 = v1 * v1;  // 333c8
      v1 = fmaD(v12, v1, v15);  // 333cc
      v1 = v13 * v1;  // 333d0
      v2 = v14 + v9;  // 333d4
      v2 = v2 * v2;  // 333d8
      v2 = fmaD(v12, v2, v14);  // 333dc
      v2 = v1 / v2;  // 333e0
      v5 = s56;  // 333e4
      v1 = v10 / v5;  // 333e8
      v6 = s32;  // 333ec
      v3 = v6 + v9;  // 333f0
      v4 = v0 / v3;  // 333f4
      v1 = v1 - v4;  // 333f8
      v0 = v1 - v0;  // 333fc
      v4 = v5 * v5;  // 33400
      v5 = v3 / v4;  // 33404
      v5 = v2 + v5;  // 33408
      v5 = v5 + v9;  // 3340c
      v5 = v5 - v0;  // 33410
      v5 = fmaD(v2, v1, v5);  // 33414
      v2 = v6 - v2;  // 33418
      v2 = v5 / v2;  // 3341c
      v3 = -v3;  // 33420
      v3 = v3 / v4;  // 33424
      v3 = fmaD(v6, v2, v3);  // 33428
      pc = 0x337ec; continue;  // 3342c
    case 0x33430:
      v0 = -4.0;  // 33430
      v1 = s40;  // 33434
      v0 = v1 + v0;  // 33438
      v1 = Math.sqrt(v0);  // 3343c
      cA = v0; cB = 0;  // 33440
      v0 = 0;  // 33444
      v0 = !(cA <= cB) ? v1 : v0;  // 33448
      v0 = v0 * v15;  // 3344c
      v0 = Math.cosh(v0);  // 33450
      v0 = v13 * v0;  // 33454
      pc = 0x33458; continue;  // fall through
    case 0x33458:
      o1 = v0;  // 33458
      v0 = v9 * v9;  // 3345c
      o2 = v0;  // 33460
      v1 = o1;  // 33464
      v2 = 1.0;  // 33468
      v3 = v2 - v1;  // 3346c
      v3 = v0 + v3;  // 33470
      v3 = v3 * v3;  // 33474
      v4 = -4.0;  // 33478
      v5 = v0 * v4;  // 3347c
      v1 = v1 + v2;  // 33480
      v0 = v0 + v1;  // 33484
      v0 = v0 * v0;  // 33488
      v0 = v2 / v0;  // 3348c
      v6 = v12 * v3;  // 33490
      v1 = -1.0;  // 33494
      v16 = s48;  // 33498
      v7 = s56;  // 33498
      v1 = v16 + v1;  // 3349c
      v4 = v7 * v0;  // 334a0
      v1 = v1 / v4;  // 334a4
      v4 = fmaD(v16, v3, -v6);  // 334a8
      v2 = v2 - v7;  // 334ac
      v2 = v4 / v2;  // 334b0
      v1 = v1 + v2;  // 334b4
      v2 = v16 * v5;  // 334b8
      v4 = 0.25;  // 334bc
      v7 = fmaD(v1, v4, v2);  // 334c0
      v4 = v3 * v0;  // 334c4
      v1 = v5 * v0;  // 334c8
      v2 = v6 * v0;  // 334cc
      v0 = v0 * v7;  // 334d0
      pc = 0x3380c; continue;  // 334d4
    case 0x334d8:
      v5 = 1.0;  // 334d8
      cA = v1; cB = v5;  // 334dc
      v12 = v10;  // 334e0
      v6 = s48;  // 334e4
      if (!(cA < cB)) { pc = 0x338c4; continue; }  // 334e8
      s16 = v0;  // 334ec
      v0 = v2 / v13;  // 334f0
      v5 = s32;  // 334f4
      v10 = v0 / v5;  // 334f8
      v5 = s24;  // 334fc
      v14 = v5 * v0;  // 33500
      v13 = v2 * v2;  // 33504
      v0 = v2 * v6;  // 33508
      v15 = v3;  // 3350c
      s48 = v4;  // 33510
      s32 = v1;  // 33514
      v0 = Math.sin(v0);  // 33518
      v0 = v0 * v0;  // 3351c
      v1 = v10 - v13;  // 33520
      v1 = v1 * v1;  // 33524
      v2 = v13 * v10;  // 33528
      v1 = fmaD(v11, v1, v2);  // 3352c
      v1 = v15 * v1;  // 33530
      v2 = v14 - v13;  // 33534
      v2 = v2 * v2;  // 33538
      v3 = v13 * v14;  // 3353c
      v2 = fmaD(v11, v2, v3);  // 33540
      v1 = v1 / v2;  // 33544
      v13 = -1.0;  // 33548
      v2 = v10 + v13;  // 3354c
      v2 = v2 * v2;  // 33550
      v2 = fmaD(v11, v2, v10);  // 33554
      v2 = v15 * v2;  // 33558
      v3 = v14 + v13;  // 3355c
      v3 = v3 * v3;  // 33560
      v3 = fmaD(v11, v3, v14);  // 33564
      v2 = v2 / v3;  // 33568
      v3 = -2.0;  // 3356c
      v0 = v3 / v0;  // 33570
      v3 = 2.0;  // 33574
      v0 = v0 + v3;  // 33578
      v3 = v2 + v13;  // 3357c
      v0 = v0 * v3;  // 33580
      v3 = v1 + v13;  // 33584
      v0 = v3 * v0;  // 33588
      v1 = v2 - v1;  // 3358c
      v0 = v0 / v1;  // 33590
      v1 = 0.4052847345693511; // @bfb68  // 33598
      v2 = s40;  // 3359c
      v14 = v2 * v1;  // 335a0
      v1 = 1.0;  // 335a4
      v1 = v1 - v8;  // 335a8
      v1 = v1 * v14;  // 335ac
      v2 = Math.sqrt(v8);  // 335b0
      cA = v8; cB = 0;  // 335b4
      v3 = 0;  // 335b8
      v2 = !(cA <= cB) ? v2 : v3;  // 335bc
      v10 = s56;  // 335c0
      v2 = v2 * v10;  // 335c4
      v1 = v1 / v2;  // 335c8
      v0 = v0 / v1;  // 335cc
      v0 = Math.log(v0);  // 335d0
      v8 = v0;  // 335d4
      v0 = v10;  // 335d8
      v0 = Math.log(v0);  // 335dc
      v1 = v8 / v0;  // 335e0
      v0 = v9 - v12;  // 335e4
      v0 = v0 * v14;  // 335e8
      v2 = v12 * v9;  // 335ec
      v8 = v0 / v2;  // 335f0
      v0 = s32;  // 335f4
      v0 = Math.pow(v0, v1);  // 335f8
      v0 = v8 * v0;  // 335fc
      v1 = v9 + v13;  // 33600
      v1 = v1 * v1;  // 33604
      v1 = fmaD(v11, v1, v9);  // 33608
      v1 = v15 * v1;  // 3360c
      v2 = v12 + v13;  // 33610
      v2 = v2 * v2;  // 33614
      v2 = fmaD(v11, v2, v12);  // 33618
      v2 = v1 / v2;  // 3361c
      v5 = s48;  // 33620
      v1 = -2.0;  // 33624
      v1 = v1 / v5;  // 33628
      v6 = s16;  // 3362c
      v3 = v6 + v13;  // 33630
      v4 = v0 / v3;  // 33634
      v1 = v1 - v4;  // 33638
      v0 = v1 - v0;  // 3363c
      v4 = v5 * v5;  // 33640
      v5 = v3 / v4;  // 33644
      v5 = v2 + v5;  // 33648
      v5 = v5 + v13;  // 3364c
      v5 = v5 - v0;  // 33650
      v5 = fmaD(v2, v1, v5);  // 33654
      v2 = v6 - v2;  // 33658
      v2 = v5 / v2;  // 3365c
      v3 = -v3;  // 33660
      v3 = v3 / v4;  // 33664
      v3 = fmaD(v6, v2, v3);  // 33668
      pc = 0x33990; continue;  // 3366c
    case 0x33670:
      v0 = -4.0;  // 33670
      v1 = s48;  // 33674
      v0 = v1 + v0;  // 33678
      v1 = Math.sqrt(v0);  // 3367c
      cA = v0; cB = 0;  // 33680
      v0 = 0;  // 33684
      v0 = !(cA <= cB) ? v1 : v0;  // 33688
      v0 = v0 * v13;  // 3368c
      v0 = Math.cosh(v0);  // 33690
      v0 = v12 * v0;  // 33694
      pc = 0x33698; continue;  // fall through
    case 0x33698:
      v7 = s56;  // 33698
      o1 = v0;  // 3369c
      v0 = v8 * v8;  // 336a0
      o2 = v0;  // 336a4
      v1 = o1;  // 336a8
      v2 = 1.0;  // 336ac
      v3 = v2 - v1;  // 336b0
      v3 = v0 + v3;  // 336b4
      v3 = v3 * v3;  // 336b8
      v4 = -4.0;  // 336bc
      v5 = v0 * v4;  // 336c0
      v1 = v1 + v2;  // 336c4
      v0 = v0 + v1;  // 336c8
      v0 = v0 * v0;  // 336cc
      v0 = v2 / v0;  // 336d0
      v6 = v11 * v3;  // 336d4
      v1 = -1.0;  // 336d8
      v1 = v15 + v1;  // 336dc
      v4 = v7 * v0;  // 336e0
      v1 = v1 / v4;  // 336e4
      v4 = fmaD(v15, v3, -v6);  // 336e8
      v2 = v2 - v7;  // 336ec
      v2 = v4 / v2;  // 336f0
      v1 = v1 + v2;  // 336f4
      v2 = v15 * v5;  // 336f8
      v4 = 0.25;  // 336fc
      v7 = fmaD(v1, v4, v2);  // 33700
      v4 = v3 * v0;  // 33704
      v1 = v5 * v0;  // 33708
      v2 = v6 * v0;  // 3370c
      v0 = v0 * v7;  // 33710
      pc = 0x339b0; continue;  // 33714
    case 0x33718:
      v0 = 0.4052847345693511; // @bfb68  // 3371c
      v1 = v0 / v11;  // 33720
      v0 = v0 / v4;  // 33724
      v0 = v1 - v0;  // 33728
      v1 = s48;  // 3372c
      v10 = v1 * v0;  // 33730
      v2 = -1.0;  // 33734
      v0 = v4 + v2;  // 33738
      v0 = v0 * v0;  // 3373c
      v0 = fmaD(v12, v0, v4);  // 33740
      v1 = v13 * v0;  // 33744
      v0 = v11 + v2;  // 33748
      v0 = v0 * v0;  // 3374c
      v2 = fmaD(v12, v0, v11);  // 33750
      v0 = s32;  // 33754
      v0 = v0 / v14;  // 33758
      v15 = v11;  // 3375c
      v3 = 0.5;  // 33760
      v9 = Math.min(v0, v3);  // 33764
      v0 = v9 * v7;  // 33768
      v14 = v1 / v2;  // 3376c
      v11 = v4;  // 33770
      v0 = Math.sin(v0);  // 33774
      v0 = v0 * v0;  // 33778
      v1 = v9 * v9;  // 3377c
      v2 = v11 - v1;  // 33780
      v2 = v2 * v2;  // 33784
      v3 = v11 * v1;  // 33788
      v2 = fmaD(v12, v2, v3);  // 3378c
      v2 = v13 * v2;  // 33790
      v3 = v15 - v1;  // 33794
      v3 = v3 * v3;  // 33798
      v1 = v15 * v1;  // 3379c
      v1 = fmaD(v12, v3, v1);  // 337a0
      v1 = v2 / v1;  // 337a4
      v5 = -1.0;  // 337a8
      v2 = v14 + v5;  // 337ac
      v3 = v14 / v2;  // 337b0
      v2 = v1 + v5;  // 337b4
      v1 = v1 / v2;  // 337b8
      v2 = v1 - v3;  // 337bc
      v4 = 1.0;  // 337c0
      v4 = v4 / v0;  // 337c4
      v2 = fmaD(v10, v2, v4);  // 337c8
      v2 = v2 + v5;  // 337cc
      v4 = -1.0;  // 337d0
      v0 = fmaD(-v1, v0, v3);  // 337d4
      v2 = v2 / v0;  // 337d8
      v0 = v10 + v2;  // 337dc
      v0 = fmaD(-v3, v0, v4);  // 337e0
      v1 = v10 + v0;  // 337e4
      v3 = 0;  // 337e8
      pc = 0x337ec; continue;  // fall through
    case 0x337ec:
      v5 = 1.0;  // 337ec
      v1 = v1 + v5;  // 337f0
      v4 = v2 + v1;  // 337f4
      v6 = -0.25;  // 337f8
      v1 = v2 * v6;  // 337fc
      v0 = v0 + v5;  // 33800
      v2 = v3 + v0;  // 33804
      v0 = v3 * v6;  // 33808
      pc = 0x3380c; continue;  // fall through
    case 0x3380c:
      v3 = Math.sqrt(v4);  // 3380c
      cA = v4; cB = 0;  // 33810
      v4 = 0;  // 33814
      v3 = !(cA <= cB) ? v3 : v4;  // 33818
      v5 = 1.0;  // 3381c
      v6 = v3 + v5;  // 33820
      v7 = 0.5;  // 33824
      v6 = v6 * v7;  // 33828
      v16 = Math.sqrt(v2);  // 3382c
      cA = v2; cB = 0;  // 33830
      v2 = !(cA <= cB) ? v16 : v4;  // 33834
      v16 = v2 + v5;  // 33838
      v7 = v16 * v7;  // 3383c
      v16 = fmaD(v6, v6, v1);  // 33840
      v17 = Math.sqrt(v16);  // 33844
      cA = v16; cB = 0;  // 33848
      v16 = !(cA <= cB) ? v17 : v4;  // 3384c
      v6 = v6 + v16;  // 33850
      v6 = v5 / v6;  // 33854
      v3 = v5 - v3;  // 33858
      o1 = v3;  // 3385c
      v1 = -v1;  // 33860
      v1 = v6 * v1;  // 33864
      o2 = v1;  // 33868
      v1 = fmaD(v7, v7, v0);  // 3386c
      v3 = Math.sqrt(v1);  // 33870
      cA = v1; cB = 0;  // 33874
      v1 = !(cA <= cB) ? v3 : v4;  // 33878
      v1 = v7 + v1;  // 3387c
      o3 = v1;  // 33880
      v1 = v5 - v2;  // 33884
      o4 = v1;  // 33888
      v0 = -v0;  // 3388c
      v1 = o3;  // 33890
      v0 = v0 / v1;  // 33894
      o5 = v0;  // 33898
      v0 = v8 * v6;  // 3389c
      v1 = o3;  // 338a0
      v1 = v1 * v0;  // 338a4
      o3 = v1;  // 338a8
      v1 = o4;  // 338ac
      v1 = v0 * v1;  // 338b0
      o4 = v1;  // 338b4
      v1 = o5;  // 338b8
      v0 = v0 * v1;  // 338bc
      pc = 0x33a60; continue;  // 338c0
    case 0x338c4:
      v0 = 0.4052847345693511; // @bfb68  // 338c8
      v1 = v0 / v12;  // 338cc
      v0 = v0 / v9;  // 338d0
      v0 = v1 - v0;  // 338d4
      v1 = s40;  // 338d8
      v8 = v1 * v0;  // 338dc
      v1 = -1.0;  // 338e0
      v0 = v9 + v1;  // 338e4
      v0 = v0 * v0;  // 338e8
      v0 = fmaD(v11, v0, v9);  // 338ec
      v0 = v3 * v0;  // 338f0
      v1 = v12 + v1;  // 338f4
      v1 = v1 * v1;  // 338f8
      v1 = fmaD(v11, v1, v12);  // 338fc
      v10 = v9;  // 33900
      v9 = v0 / v1;  // 33904
      v0 = 0.5;  // 33908
      v13 = Math.min(v15, v0);  // 3390c
      v0 = v13 * v6;  // 33910
      v14 = v3;  // 33914
      v0 = Math.sin(v0);  // 33918
      v0 = v0 * v0;  // 3391c
      v1 = v13 * v13;  // 33920
      v2 = v10 - v1;  // 33924
      v2 = v2 * v2;  // 33928
      v3 = v10 * v1;  // 3392c
      v2 = fmaD(v11, v2, v3);  // 33930
      v2 = v14 * v2;  // 33934
      v3 = v12 - v1;  // 33938
      v3 = v3 * v3;  // 3393c
      v1 = v12 * v1;  // 33940
      v1 = fmaD(v11, v3, v1);  // 33944
      v1 = v2 / v1;  // 33948
      v5 = -1.0;  // 3394c
      v2 = v9 + v5;  // 33950
      v3 = v9 / v2;  // 33954
      v2 = v1 + v5;  // 33958
      v1 = v1 / v2;  // 3395c
      v2 = v1 - v3;  // 33960
      v4 = 1.0;  // 33964
      v4 = v4 / v0;  // 33968
      v2 = fmaD(v8, v2, v4);  // 3396c
      v2 = v2 + v5;  // 33970
      v4 = -1.0;  // 33974
      v0 = fmaD(-v1, v0, v3);  // 33978
      v2 = v2 / v0;  // 3397c
      v0 = v8 + v2;  // 33980
      v0 = fmaD(-v3, v0, v4);  // 33984
      v1 = v8 + v0;  // 33988
      v3 = 0;  // 3398c
      pc = 0x33990; continue;  // fall through
    case 0x33990:
      v5 = 1.0;  // 33990
      v1 = v1 + v5;  // 33994
      v4 = v2 + v1;  // 33998
      v6 = -0.25;  // 3399c
      v1 = v2 * v6;  // 339a0
      v0 = v0 + v5;  // 339a4
      v2 = v3 + v0;  // 339a8
      v0 = v3 * v6;  // 339ac
      pc = 0x339b0; continue;  // fall through
    case 0x339b0:
      v3 = Math.sqrt(v4);  // 339b0
      cA = v4; cB = 0;  // 339b4
      v4 = 0;  // 339b8
      v3 = !(cA <= cB) ? v3 : v4;  // 339bc
      v5 = 1.0;  // 339c0
      v6 = v3 + v5;  // 339c4
      v7 = 0.5;  // 339c8
      v6 = v6 * v7;  // 339cc
      v16 = Math.sqrt(v2);  // 339d0
      cA = v2; cB = 0;  // 339d4
      v2 = !(cA <= cB) ? v16 : v4;  // 339d8
      v16 = v2 + v5;  // 339dc
      v7 = v16 * v7;  // 339e0
      v16 = fmaD(v6, v6, v1);  // 339e4
      v17 = Math.sqrt(v16);  // 339e8
      cA = v16; cB = 0;  // 339ec
      v16 = !(cA <= cB) ? v17 : v4;  // 339f0
      v6 = v6 + v16;  // 339f4
      v6 = v5 / v6;  // 339f8
      v3 = v5 - v3;  // 339fc
      o1 = v3;  // 33a00
      v1 = -v1;  // 33a04
      v1 = v6 * v1;  // 33a08
      o2 = v1;  // 33a0c
      v1 = fmaD(v7, v7, v0);  // 33a10
      v3 = Math.sqrt(v1);  // 33a14
      cA = v1; cB = 0;  // 33a18
      v1 = !(cA <= cB) ? v3 : v4;  // 33a1c
      v1 = v7 + v1;  // 33a20
      o3 = v1;  // 33a24
      v1 = v5 - v2;  // 33a28
      o4 = v1;  // 33a2c
      v0 = -v0;  // 33a30
      v1 = o3;  // 33a34
      v0 = v0 / v1;  // 33a38
      o5 = v0;  // 33a3c
      v0 = o3;  // 33a40
      v0 = v6 * v0;  // 33a44
      o3 = v0;  // 33a48
      v0 = o4;  // 33a4c
      v0 = v6 * v0;  // 33a50
      o4 = v0;  // 33a54
      v0 = o5;  // 33a58
      v0 = v6 * v0;  // 33a5c
      pc = 0x33a60; continue;  // fall through
    case 0x33a60:
      o5 = v0;  // 33a60
      v0 = o1;  // 33a64
      v0 = v6 * v0;  // 33a68
      o1 = v0;  // 33a6c
      v0 = o2;  // 33a70
      v0 = v6 * v0;  // 33a74
      pc = 0x33a78; continue;  // fall through
    case 0x33a78:
      o2 = v0;  // 33a78
      pc = 0x33a7c; continue;  // fall through
    case 0x33a7c:
      out[0] = o1; out[1] = o2; out[2] = o3; out[3] = o4; out[4] = o5;
      return;  // 33aa0
    default: throw new Error("bad pc " + pc.toString(16));
    }
  }

}
