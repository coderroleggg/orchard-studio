// Song-tick clock for controller plugins. FL calls a controller's NewTick
// once per song tick (PPQ ticks per beat at the current tempo), also while
// the transport is stopped; the audio of a tick is rendered after its tick.
//
//   clock.setRate(sr, tempo, ppq);
//   for (let i = 0; i < n;) {
//     if (clock.due()) onTick(i);
//     const m = clock.span(n - i); // samples until the next tick (or the block end)
//     ...process samples i .. i + m...
//     i += m;
//   }

export class TickClock {
  /** Samples until the next tick. */
  private left = 0;
  /** Samples per tick. */
  spt = 1;

  setRate(sampleRate: number, tempo: number, ppq: number): void {
    this.spt = (sampleRate * 60) / (Math.max(1, tempo) * (ppq > 0 ? ppq : 96));
  }

  /** A tick starts at the current sample (the clock advances to the next one). */
  due(): boolean {
    if (this.left > 0) return false;
    this.left += this.spt;
    return true;
  }

  /** Consume up to `rest` samples, stopping at the next tick. */
  span(rest: number): number {
    const m = Math.min(rest, Math.max(1, Math.ceil(this.left)));
    this.left -= m;
    return m;
  }

  reset(): void {
    this.left = 0;
  }
}
