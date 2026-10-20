// The Dance character's animation logic (no DOM, so the tests can drive it):
// which sprite sheet cells to show for the song position, as measured on FL's
// plugin (docs/research/gen/dance.md).
//
// - While the song plays the frame is a function of the song position alone:
//   floor(beats x 4 / (1 + |speed| / 32)) mod 8 (src/model/gen/plugins/dance.ts:
//   dancePhase), with FL's quirk that a speed changed from a positive speed
//   runs faster instead of slower (danceFramesPerBeat); the character stands
//   still on frame 0 while the song is stopped.
// - Motion blending crossfades the current cell into the next one over the last
//   blend / 256 of each frame (danceBlend).
// - Sync changes: while the song plays, a new move or mirror state waits for the
//   end of the running cycle (the last frame already blends into the new one);
//   without Sync, or while the song is stopped, changes apply at once. The "end of
//   the cycle" is the position inside the cycle going below the last one (measured:
//   that is also what a speed change to an earlier place in the cycle does, so it
//   can apply a pending change at once, or leave it waiting for the next wrap). A change
//   noticed within `grace` beats after a cycle began counts as made before it: FL's
//   notes reach the plugin a little ahead of the audible position, ours (reported
//   back to the page by the engine) a little behind, and a note on the downbeat
//   must still switch at that downbeat.
// - Freestyle plays a random move (never the first) for each cycle.
// - Holding the character with the mouse shows the sheet's last row ("Held"),
//   at once, never mirrored, running at the base speed (the Speed slider does not
//   apply to it) and crossfading over the last two thirds of each frame whatever
//   the Blend slider says.

import {
  DANCE_FRAMES, DANCE_HELD_BLEND, danceBlend, danceFramesPerBeat, danceFreeRow, danceRowOf, dancePhase, danceSpeedInverse,
} from '../../../../model/gen/plugins/dance';

/** What the animation needs from the plugin's state and its sprite sheet. */
export interface AnimTarget {
  /** Parameter 0: 0 Freestyle, 1.. the sheet's moves. */
  move: number;
  mirror: boolean;
  /** 0..256. */
  blend: number;
  /** -96..96. */
  speed: number;
  sync: boolean;
  /** Number of rows that are moves (the sheet's rows but the Held one). */
  moves: number;
  /** The row the mouse holds the character with. */
  heldRow: number;
}

/** The cells to draw: the current one and the next one at weight `t`. */
export interface AnimFrame {
  row: number;
  col: number;
  mirror: boolean;
  row2: number;
  col2: number;
  mirror2: boolean;
  /** Share of the second cell (0 = only the first). */
  t: number;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export class DanceAnimator {
  /** The move / mirror state on screen (it follows the target at a cycle's end when Sync is on). */
  private shownMove = -1;
  private shownMirror = false;
  /** The running dance cycle (null: not playing / unknown, the next frame starts afresh). */
  private cycle: number | null = null;
  /** Freestyle's row for the running cycle and for the next one (picked in advance: the last frame blends into it). */
  private curFree = 0;
  private nextFree = 0;
  /** The target last seen (a change is noticed once). */
  private seenMove = -1;
  private seenMirror = false;
  /** The speed last seen and FL's speed mode (see danceFramesPerBeat): decided by changes of the speed only. */
  private lastSpeed: number | null = null;
  private inverse = false;
  /** The position inside the dance cycle (0..8 frames) at the last frame (null: none yet). */
  private lastX: number | null = null;
  /** The song position at the last frame (to ignore small backward jitter of the position). */
  private lastBeat: number | null = null;

  constructor(private readonly rand: () => number = Math.random) {}

  /** Forget the running cycle (a new sheet, a restarted song). */
  reset(): void {
    this.cycle = null;
    this.lastX = null;
    this.lastBeat = null;
    this.shownMove = -1;
  }

  /** The state on screen: [move, mirror] (before the next call applies a pending change). */
  shown(): [number, boolean] {
    return [this.shownMove, this.shownMirror];
  }

  /**
   * The frame for the song position `beat` (in beats). `playing` is the transport state, `held` whether
   * the mouse holds the character, `grace` (beats) how long after a cycle began a change still counts as
   * made before it (0 = exactly at the end of the cycle), `jitter` (beats) the size of backward steps of
   * the position that are noise of the page's position estimate and not a jump (FL's own is smooth: any
   * backward step it sees ends the cycle).
   */
  frame(beat: number, playing: boolean, held: boolean, tg: AnimTarget, grace = 0, jitter = 0): AnimFrame {
    const M = Math.max(1, tg.moves);
    const changed = tg.move !== this.seenMove || tg.mirror !== this.seenMirror;
    this.seenMove = tg.move;
    this.seenMirror = tg.mirror;
    if (this.lastSpeed !== null && tg.speed !== this.lastSpeed) this.inverse = danceSpeedInverse(this.lastSpeed, tg.speed);
    this.lastSpeed = tg.speed;
    if (!playing || !Number.isFinite(beat)) {
      // stopped: frame 0 of the current move, changes at once
      if (this.cycle !== null || this.shownMove < 0) { this.curFree = danceFreeRow(M, this.rand()); this.nextFree = danceFreeRow(M, this.rand()); }
      this.cycle = null;
      this.lastX = null;
      this.lastBeat = null;
      this.shownMove = tg.move;
      this.shownMirror = tg.mirror;
      const row = held ? tg.heldRow : danceRowOf(this.shownMove, M, this.curFree);
      const mir = held ? false : this.shownMirror;
      return { row, col: 0, mirror: mir, row2: row, col2: 0, mirror2: mir, t: 0 };
    }

    if (this.lastBeat !== null && beat < this.lastBeat && this.lastBeat - beat < jitter) beat = this.lastBeat;
    this.lastBeat = beat;
    const phase = dancePhase(beat, tg.speed, this.inverse);
    const fl = Math.floor(phase);
    const k = mod(fl, DANCE_FRAMES);
    const frac = phase - fl;
    const cyc = Math.floor(fl / DANCE_FRAMES);
    const xPos = phase - cyc * DANCE_FRAMES;
    const lastX = this.lastX;
    this.lastX = xPos;
    const first = this.cycle === null;
    // measured: a pending change applies whenever the position inside the cycle goes below the last one: the natural
    // wrap, but also a jump of the speed (the phase is a function of the song position and the speed) or of the position
    // to an earlier place in the cycle; a jump to a later (or the same) place leaves the change waiting for the next wrap,
    // whatever the cycle counter or the frame index say
    const wrapped = !first && lastX !== null && xPos < lastX;
    if (first) {
      // the first frame (after start, stop or a new sheet): the state on screen is the target
      this.cycle = cyc;
      this.shownMove = tg.move;
      this.shownMirror = tg.mirror;
      this.curFree = danceFreeRow(M, this.rand());
      this.nextFree = danceFreeRow(M, this.rand());
    } else if (wrapped) {
      // a new cycle: the pending change applies (Freestyle's row was picked in advance unless the cycle did not simply follow)
      const natural = cyc === (this.cycle as number) + 1;
      this.cycle = cyc;
      this.shownMove = tg.move;
      this.shownMirror = tg.mirror;
      this.curFree = natural ? this.nextFree : danceFreeRow(M, this.rand());
      this.nextFree = danceFreeRow(M, this.rand());
    } else {
      this.cycle = cyc;
      if (!tg.sync) {
        this.shownMove = tg.move;
        this.shownMirror = tg.mirror;
      } else if (changed && grace > 0 && xPos / danceFramesPerBeat(tg.speed, this.inverse) < grace) {
        // noticed just after the cycle began (beats since it began < grace): it was meant for this cycle
        this.shownMove = tg.move;
        this.shownMirror = tg.mirror;
      }
    }

    if (held) {
      // the Held row: the base frame law (speed 0), no mirror, its own fixed crossfade
      const hp = dancePhase(beat, 0);
      const hf = Math.floor(hp);
      const hk = mod(hf, DANCE_FRAMES);
      return { row: tg.heldRow, col: hk, mirror: false, row2: tg.heldRow, col2: (hk + 1) % DANCE_FRAMES, mirror2: false, t: danceBlend(hp - hf, DANCE_HELD_BLEND) };
    }
    const wrap = k === DANCE_FRAMES - 1;
    const k2 = (k + 1) % DANCE_FRAMES;
    const row = danceRowOf(this.shownMove, M, this.curFree);
    // the next frame after the last one is the first of the next cycle: it already shows the target state
    const mirror2 = wrap ? tg.mirror : this.shownMirror;
    const row2 = danceRowOf(wrap ? tg.move : this.shownMove, M, wrap ? this.nextFree : this.curFree);
    return { row, col: k, mirror: this.shownMirror, row2, col2: k2, mirror2, t: danceBlend(frac, tg.blend) };
  }
}
