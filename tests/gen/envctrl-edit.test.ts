// The Envelope Controller editor's pure edit operations (points, section markers, clipboard, step drawing, grid).
import { describe, expect, it } from 'vitest';
import { ecPoint, type EcShape } from '../../src/model/gen/plugins/envctrl';
import {
  clampPos, contentSpan, copyPoints, drawSteps, duplicatePoints, flipValues, hasMarker, insertIndexFor, insertPoint, isFlat, markerAllowed,
  markerLetters, normalizeValues, pastePoints, removePoints, timeGrid, toggleMarker,
} from '../../src/ui/plugins/gen/envctrl/shapeOps';

const shape = (xs: Array<[number, number]>, m: Partial<EcShape> = {}): EcShape => ({
  pts: xs.map(([p, v]) => ecPoint(p, v)), on: true, tempo: false, global: false, d: -1, l: -1, s: -1, ...m,
});
const adsr = () => shape([[0, 0], [0.75, 1], [2.25, 0.5], [2.5, 0]], { d: 1, s: 2 });

describe('Envelope Controller editor: points and markers', () => {
  it('inserts a point behind the points at its position and shifts the markers behind it', () => {
    const sh = adsr();
    expect(insertIndexFor(sh.pts, 1.0)).toBe(2);
    expect(insertIndexFor(sh.pts, 0.75)).toBe(2);
    expect(insertIndexFor(sh.pts, 9)).toBe(4);
    const n = insertPoint(sh, 2, ecPoint(1.5, 0.7));
    expect(n.pts.map((p) => p.pos)).toEqual([0, 0.75, 1.5, 2.25, 2.5]);
    expect([n.d, n.l, n.s]).toEqual([1, -1, 3]);
    // inserting in front of a marker moves it, behind it keeps it
    expect(insertPoint(sh, 1, ecPoint(0.3, 0.2)).d).toBe(2);
    expect(insertPoint(sh, 3, ecPoint(2.3, 0.2)).s).toBe(2);
    expect(sh.pts).toHaveLength(4); // the input stays untouched
  });

  it('deletes points: the first point stays, markers follow or vanish with their point', () => {
    const sh = adsr();
    expect(removePoints(sh, [0])).toBe(sh);
    const n = removePoints(sh, [1]);
    expect(n.pts.map((p) => p.pos)).toEqual([0, 2.25, 2.5]);
    expect(n.d).toBe(-1);
    expect(n.s).toBe(1);
    expect(removePoints(sh, [3]).s).toBe(2);
    // never below two points
    const two = shape([[0, 0], [1, 1]]);
    expect(removePoints(two, [1])).toBe(two);
    expect(removePoints(sh, [1, 2, 3]).pts).toHaveLength(2);
  });

  it('allows the markers FL allows: D up to S, L before the section end, S behind D and L', () => {
    const sh = adsr();
    expect(markerAllowed(sh, 'd', 2)).toBe(true);
    expect(markerAllowed(sh, 'd', 3)).toBe(false); // behind the sustain
    expect(markerAllowed(sh, 'l', 1)).toBe(true);
    expect(markerAllowed(sh, 'l', 2)).toBe(false); // not on the sustain itself
    expect(markerAllowed(sh, 's', 0)).toBe(false); // before D
    expect(markerAllowed(sh, 's', 3)).toBe(true);
    const free = shape([[0, 0], [1, 1], [2, 0]]);
    expect(markerAllowed(free, 'l', 1)).toBe(true);
    expect(markerAllowed(free, 'l', 2)).toBe(false); // the last point ends the section
    expect(markerAllowed(free, 'dl', 1)).toBe(true);
    expect(markerAllowed(free, 'd', 9)).toBe(false);
  });

  it('toggles markers on and off and writes DL as both', () => {
    const sh = shape([[0, 0], [1, 1], [2, 0.5], [3, 0]]);
    const a = toggleMarker(sh, 's', 2);
    expect(a.s).toBe(2);
    expect(hasMarker(a, 's', 2)).toBe(true);
    expect(toggleMarker(a, 's', 2).s).toBe(-1);
    const b = toggleMarker(a, 'dl', 1);
    expect([b.d, b.l]).toEqual([1, 1]);
    expect(markerLetters(b, 1)).toBe('DL');
    expect(markerLetters(b, 2)).toBe('S');
    expect(markerLetters(b, 0)).toBe('');
    expect(toggleMarker(b, 'dl', 1).d).toBe(-1);
    // a refused marker leaves the shape alone
    expect(toggleMarker(a, 'l', 2)).toBe(a);
  });

  it('flips and normalises values', () => {
    const sh = shape([[0, 0.2], [1, 0.6], [2, 0.4]]);
    expect(flipValues(sh).pts.map((p) => p.value)).toEqual([0.8, 0.4, 0.6]);
    const part = flipValues(sh, new Set([1]));
    expect(part.pts.map((p) => p.value)).toEqual([0.2, 0.4, 0.4]);
    const n = normalizeValues(sh);
    expect(n.pts.map((p) => +p.value.toFixed(6))).toEqual([0, 1, 0.5]);
    const flat = shape([[0, 0.3], [1, 0.3]]);
    expect(normalizeValues(flat)).toBe(flat);
    expect(isFlat(flat)).toBe(true);
    expect(isFlat(sh)).toBe(false);
  });

  it('copies, pastes (insert / replace) and duplicates points', () => {
    const sh = shape([[0, 0], [1, 1], [2, 0.5], [3, 0.2], [4, 0]]);
    const clip = copyPoints(sh, new Set([1, 2]))!;
    expect(clip.pts.map((p) => [p.dx, p.value])).toEqual([[0, 1], [1, 0.5]]);
    // insert at 3.5: the points behind move later by the pasted length (1)
    const ins = pastePoints(sh, clip, 3.5, false);
    expect(ins.shape.pts.map((p) => +p.pos.toFixed(3))).toEqual([0, 1, 2, 3, 3.5, 4.5, 5, ]);
    expect(ins.added).toEqual([4, 5]);
    // replace removes what lies in the pasted range
    const rep = pastePoints(sh, clip, 2.5, true);
    expect(rep.shape.pts.map((p) => +p.pos.toFixed(3))).toEqual([0, 1, 2, 2.5, 3.5, 4]);
    // duplicate puts the copy behind the selection
    const dup = duplicatePoints(sh, new Set([1, 2]));
    expect(dup.added).toHaveLength(2);
    const ps = dup.shape.pts.map((p) => p.pos);
    expect(ps).toEqual([...ps].sort((a, b) => a - b));
    expect(dup.shape.pts).toHaveLength(7);
  });

  it('draws steps: one control point per grid step with the pointer value, pulse lines hold', () => {
    const sh = shape([[0, 0], [2, 0]]);
    const a = drawSteps(sh, 0.4, 1.0, 0.8, 0.2, false);
    expect(a.pts.map((p) => +p.pos.toFixed(3))).toEqual([0, 0.4, 0.6, 0.8, 1, 2]);
    expect(a.pts.slice(1, 5).every((p) => p.value === 0.8 && p.mode === 'single')).toBe(true);
    const b = drawSteps(a, 0.6, 0.6, 0.1, 0.2, true);
    expect(b.pts.find((p) => Math.abs(p.pos - 0.6) < 1e-6)).toMatchObject({ value: 0.1, mode: 'hold' });
    expect(b.pts).toHaveLength(a.pts.length);
    // a stroke over existing points replaces them (the markers follow)
    const m = shape([[0, 0], [0.5, 1], [1, 0.5], [2, 0]], { d: 1, s: 2 });
    const c = drawSteps(m, 0.2, 1.1, 0.3, 0.1, false);
    expect(c.pts[0].pos).toBe(0);
    expect(c.s).toBe(-1);
    expect(c.pts.every((p, i) => i === 0 || p.pos > c.pts[i - 1].pos)).toBe(true);
    // on a mapping axis the stroke stays inside
    const d = drawSteps(shape([[0, 0], [1, 0]]), 0.8, 1.4, 0.5, 0.1, false, 0, 1);
    expect(Math.max(...d.pts.map((p) => p.pos))).toBeLessThanOrEqual(1);
  });

  it('clamps a dragged point between its neighbours; the first point stays at 0', () => {
    const sh = adsr();
    expect(clampPos(sh.pts, 0, 1, false)).toBe(0);
    expect(clampPos(sh.pts, 1, 5, false)).toBe(2.25);
    expect(clampPos(sh.pts, 1, -1, false)).toBe(0);
    expect(clampPos(sh.pts, 3, 9, false)).toBe(9); // the last point may extend the envelope
    expect(clampPos(sh.pts, 3, 9, true)).toBe(2.5);
  });

  it('lays out FL\'s grid: 0.1 s lines, a major line per second (a beat quarter / beat when tempo based)', () => {
    const px = 720 / 3.5;
    const g = timeGrid(false, px);
    expect(g.step).toBeCloseTo(0.2, 9);
    expect(g.every).toBe(10);
    const t = timeGrid(true, px);
    expect(t.step).toBeCloseTo(0.25, 9);
    expect(t.every).toBe(4);
    // zooming out doubles the spacing, zooming in halves it
    expect(timeGrid(false, 15).step).toBeGreaterThan(0.2);
    expect(timeGrid(false, 900).step).toBeLessThan(0.2);
    expect(contentSpan(adsr())).toBeCloseTo(3.5, 9);
    expect(contentSpan(shape([[0, 0], [10, 1]]))).toBeCloseTo(11.5, 9);
  });
});
