// Musical time helpers. Positions are stored in ticks at the project's PPQ
// (pulses per quarter note). FL's default PPQ is 96, so with 4 steps per beat a
// step is 24 ticks and a 4/4 bar is 384 ticks.

export interface TimeBase {
  ppq: number;
  beatsPerBar: number;
  stepsPerBeat: number;
}

export function ticksPerStep(t: TimeBase): number {
  return t.ppq / t.stepsPerBeat;
}

export function ticksPerBar(t: TimeBase): number {
  return t.ppq * t.beatsPerBar;
}

export function stepsPerBar(t: TimeBase): number {
  return t.beatsPerBar * t.stepsPerBeat;
}

/** Seconds per tick at `bpm`. */
export function secondsPerTick(bpm: number, ppq: number): number {
  return 60 / (bpm * ppq);
}

/** "Bar:Step:Tick" style display, 1-based bar and step like FL's B:S:T. */
export function formatBST(tick: number, t: TimeBase): { bar: number; step: number; tick: number } {
  const tps = ticksPerStep(t);
  const spb = stepsPerBar(t);
  const totalSteps = Math.floor(tick / tps);
  const bar = Math.floor(totalSteps / spb) + 1;
  const step = (totalSteps % spb) + 1;
  const tk = Math.floor(tick - totalSteps * tps);
  return { bar, step, tick: tk };
}

/** Minutes:Seconds:Centiseconds display (M:S:CS). */
export function formatMSC(seconds: number): { min: number; sec: number; cs: number } {
  const s = Math.max(0, seconds);
  const min = Math.floor(s / 60);
  const sec = Math.floor(s - min * 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return { min, sec, cs };
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
