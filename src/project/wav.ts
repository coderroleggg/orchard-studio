// 16 / 24-bit PCM WAV encoder with TPDF dither, and 32-bit float WAV.

export function encodeWav(channels: Float32Array[], sampleRate: number, bits: 16 | 24 | 32 = 24): ArrayBuffer {
  const nch = channels.length;
  const frames = channels[0].length;
  if (bits === 32) return encodeFloatWav(channels, sampleRate);
  const bytesPerSample = bits / 8;
  const dataSize = frames * nch * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * bytesPerSample, true);
  v.setUint16(32, nch * bytesPerSample, true);
  v.setUint16(34, bits, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  const max = bits === 24 ? 8388607 : 32767;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const dither = (Math.random() - Math.random()) / max;
      const x = Math.max(-1, Math.min(1, channels[c][i] + dither));
      const s = Math.round(x * max);
      if (bits === 24) {
        v.setUint8(o, s & 0xff);
        v.setUint8(o + 1, (s >> 8) & 0xff);
        v.setUint8(o + 2, (s >> 16) & 0xff);
      } else {
        v.setInt16(o, s, true);
      }
      o += bytesPerSample;
    }
  }
  return buf;
}

/** 32-bit IEEE float WAV (format 3), exact copies of the samples. */
function encodeFloatWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const nch = channels.length;
  const frames = channels[0].length;
  const dataSize = frames * nch * 4;
  const buf = new ArrayBuffer(44 + 12 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + 12 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 4, true);
  v.setUint16(32, nch * 4, true);
  v.setUint16(34, 32, true);
  str(36, 'fact');
  v.setUint32(40, 4, true);
  v.setUint32(44, frames, true);
  str(48, 'data');
  v.setUint32(52, dataSize, true);
  let o = 56;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) { v.setFloat32(o, channels[c][i], true); o += 4; }
  }
  return buf;
}
