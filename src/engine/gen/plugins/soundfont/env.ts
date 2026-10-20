// FL's SoundFont Player envelope (Sobanth TVoiceEnvelope, Process 0x1d5520 / Release 0x1d53a0): a stage machine
// ticked once per 32-sample control block of the voice. Six stages (0 delay, 1 attack, 2 hold, 3 decay, 4 sustain,
// 5 release), then 6 = finished. Each stage holds a block count and a recurrence v = a v + b (clamped to [lo, hi],
// leaving the stage when it hits a clamp or when the count of blocks has run): delay 0 x v for `delay` blocks,
// attack v + 1/count to 1, hold v, decay v - 1/count down to the sustain fraction, sustain forever, release v - 1/count
// down to 0. The value is linear in 0..1; the volume envelope uses it as a linear amplitude in the attack stage and as
// a level in a 96 dB range (attenuation = 960 (1 - v) cB) in every other stage; the modulation envelope uses it as is.

export const ENV_DELAY = 0, ENV_ATTACK = 1, ENV_HOLD = 2, ENV_DECAY = 3, ENV_SUSTAIN = 4, ENV_RELEASE = 5, ENV_DONE = 6;

/** Stage data, 6 stages: [count, a, b, lo, hi]. */
export class SfEnv {
  stage = 0;
  /** Blocks spent in the current stage (FL +0x2f0). */
  pos = 0;
  /** Current value (+0x2e0) and the output (+0x2e8, the same for SF2 envelopes: no shaping curve). */
  value = 0;
  out = 0;
  readonly count = new Int32Array(6);
  readonly a = new Float64Array(6);
  readonly b = new Float64Array(6);
  readonly lo = new Float64Array(6);
  readonly hi = new Float64Array(6);

  constructor() {
    this.reset();
  }

  reset(): void {
    this.stage = 0; this.pos = 0; this.value = 0; this.out = 0;
    // stage defaults (the constructor values): delay 0 x v, sustain holds forever
    this.a.fill(1); this.b.fill(0); this.lo.fill(-1); this.hi.fill(2); this.count.fill(0);
    this.a[ENV_DELAY] = 0; this.hi[ENV_DELAY] = 1;
    this.hi[ENV_ATTACK] = 1;
    this.count[ENV_SUSTAIN] = 0x7fffffff;
  }

  /** Configure the six stages (counts in blocks; sustain = the fraction the decay falls to). */
  setup(delay: number, attack: number, hold: number, decay: number, sustain: number, release: number): void {
    this.count[ENV_DELAY] = delay; this.a[ENV_DELAY] = 0; this.b[ENV_DELAY] = 0; this.lo[ENV_DELAY] = -1; this.hi[ENV_DELAY] = 1;
    this.count[ENV_ATTACK] = attack; this.a[ENV_ATTACK] = 1; this.b[ENV_ATTACK] = attack !== 0 ? 1 / attack : 0; this.lo[ENV_ATTACK] = -1; this.hi[ENV_ATTACK] = 1;
    this.count[ENV_HOLD] = hold; this.a[ENV_HOLD] = 1; this.b[ENV_HOLD] = 0; this.lo[ENV_HOLD] = -1; this.hi[ENV_HOLD] = 2;
    this.count[ENV_DECAY] = decay; this.a[ENV_DECAY] = 1; this.b[ENV_DECAY] = decay !== 0 ? -1 / decay : 0; this.lo[ENV_DECAY] = sustain; this.hi[ENV_DECAY] = 2;
    this.count[ENV_SUSTAIN] = 0x7fffffff; this.a[ENV_SUSTAIN] = 1; this.b[ENV_SUSTAIN] = 0; this.lo[ENV_SUSTAIN] = -1; this.hi[ENV_SUSTAIN] = 2;
    this.count[ENV_RELEASE] = release; this.a[ENV_RELEASE] = 1; this.b[ENV_RELEASE] = release !== 0 ? -1 / release : 0; this.lo[ENV_RELEASE] = 0; this.hi[ENV_RELEASE] = 2;
  }

  /** Update the stages that can change while a voice plays (generator overrides, modulators): same as setup() but keeps the state. */
  retune(delay: number, attack: number, hold: number, decay: number, sustain: number, release: number): void {
    this.setup(delay, attack, hold, decay, sustain, release);
  }

  /** Note off: start the release from the current value. */
  release(): void {
    if (this.stage >= ENV_RELEASE) return;
    this.stage = ENV_RELEASE;
    this.pos = 0;
  }

  /** One control block (0x1d5520, stage-based path). */
  tick(): void {
    let s = this.stage;
    // leave the stages that ran their blocks
    while (s !== ENV_DONE && s <= ENV_RELEASE && this.count[s] <= this.pos) {
      s++;
      this.pos = 0;
      this.stage = s;
    }
    if (s > ENV_RELEASE) {
      this.stage = ENV_DONE;
      this.value = 0;
      this.out = 0;
      return;
    }
    let v = this.a[s] * this.value + this.b[s];
    if (v < this.lo[s]) {
      v = this.lo[s];
      if (this.stage !== ENV_DONE) this.stage++;
      this.pos = 0;
    } else if (v > this.hi[s]) {
      v = this.hi[s];
      if (this.stage !== ENV_DONE) this.stage++;
      this.pos = 0;
    } else {
      this.pos++;
    }
    this.value = v;
    this.out = v;
  }

  get done(): boolean {
    return this.stage >= ENV_DONE;
  }
}
