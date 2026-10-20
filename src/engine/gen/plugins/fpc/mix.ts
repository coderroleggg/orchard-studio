// FPC's mixing kernels (FPC_x64.dylib, arm64 NEON routines 0x395c and 0x3c3c,
// installed as the DSP unit's add-with-gain helpers): a voice's stereo
// buffer is added into an output buffer with a constant gain, or with a
// linear gain ramp. Reproduced in single precision and in the routines' own
// operation order, including the ramp's scalar tail (count % 8 frames), which
// steps the left gain by the right step and vice versa.

const f32 = Math.fround;

/** dst += src x (gl, gr) for n frames from the given offsets (separate multiply and add, no FMA). */
export function mixConst(sL: Float32Array, sR: Float32Array, so: number, dL: Float32Array, dR: Float32Array, d0: number, n: number, gl: number, gr: number): void {
  for (let i = 0; i < n; i++) {
    dL[d0 + i] = f32(dL[d0 + i] + f32(sL[so + i] * gl));
    dR[d0 + i] = f32(dR[d0 + i] + f32(sR[so + i] * gr));
  }
}

/**
 * dst += src x gain ramp for n frames (FL's 0x3c3c): gains start at (cl, cr) and grow by (sl, sr) per frame,
 * accumulated two frames at a time in the 8-frame vector loop; the remaining n % 8 frames continue from the
 * vector's gain with the steps swapped (sr on the left, sl on the right), as FL's routine does.
 */
export function mixRamp(sL: Float32Array, sR: Float32Array, so: number, dL: Float32Array, dR: Float32Array, d0: number, n: number,
  cl: number, cr: number, sl: number, sr: number): void {
  // v0 = [cl, cr, cl + sl, cr + sr]
  let a0 = cl, a1 = cr, a2 = f32(cl + sl), a3 = f32(cr + sr);
  let i = 0;
  if (n >= 8) {
    const s2l = f32(sl + sl), s2r = f32(sr + sr);
    const full = n & ~7;
    for (; i < full; i += 2) {
      dL[d0 + i] = f32(f32(sL[so + i] * a0) + dL[d0 + i]);
      dR[d0 + i] = f32(f32(sR[so + i] * a1) + dR[d0 + i]);
      dL[d0 + i + 1] = f32(f32(sL[so + i + 1] * a2) + dL[d0 + i + 1]);
      dR[d0 + i + 1] = f32(f32(sR[so + i + 1] * a3) + dR[d0 + i + 1]);
      a0 = f32(s2l + a0); a1 = f32(s2r + a1); a2 = f32(s2l + a2); a3 = f32(s2r + a3);
    }
  }
  for (; i < n; i++) {
    dL[d0 + i] = f32(dL[d0 + i] + f32(sL[so + i] * a0));
    dR[d0 + i] = f32(dR[d0 + i] + f32(sR[so + i] * a1));
    a0 = f32(sr + a0);
    a1 = f32(sl + a1);
  }
}

/** FL's buffer add (output buffers into the mixer track): dst += src. */
export function addBuf(sL: Float32Array, sR: Float32Array, dL: Float32Array, dR: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    dL[i] = f32(dL[i] + sL[i]);
    dR[i] = f32(dR[i] + sR[i]);
  }
}
