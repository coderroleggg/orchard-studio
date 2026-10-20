import { describe, it, expect } from 'vitest';
import { Store } from '../src/store/createStore';

interface P { notes: number[]; volume: number; }

function make() {
  return new Store<P, Record<string, never>>({ notes: [], volume: 0.78 }, {});
}

describe('patch-based undo', () => {
  it('collapses a gesture into one step and redoes it', () => {
    const s = make();
    s.beginGesture('Move');
    s.update('Move', (d) => { d.notes.push(1); });
    s.update('Move', (d) => { d.notes.push(2); });
    s.endGesture();
    expect(s.historyLabels().past).toEqual(['Move']);
    s.undo();
    expect(s.project.notes).toEqual([]);
    s.redo();
    expect(s.project.notes).toEqual([1, 2]);
  });

  it('knob tweaks are not recorded by default and survive undoing other edits', () => {
    const s = make();
    s.update('Add note', (d) => { d.notes.push(5); });
    s.nextGestureIsKnob = true;
    s.beginGesture('Channel volume');
    s.update('Channel volume', (d) => { d.volume = 0.5; });
    s.endGesture();
    expect(s.historyLabels().past).toEqual(['Add note']);
    s.undo();
    expect(s.project.notes).toEqual([]);
    expect(s.project.volume).toBe(0.5); // the knob value is kept
  });

  it('records knob tweaks when "Undo knob tweaks" is on', () => {
    const s = make();
    s.undoKnobTweaks = true;
    s.nextGestureIsKnob = true;
    s.beginGesture('Channel volume');
    s.update('Channel volume', (d) => { d.volume = 0.25; });
    s.endGesture();
    s.undo();
    expect(s.project.volume).toBe(0.78);
  });

  it('merges consecutive updates with the same merge key', () => {
    const s = make();
    s.update('Tempo', (d) => { d.volume = 0.1; }, { mergeKey: 'tempo' });
    s.update('Tempo', (d) => { d.volume = 0.2; }, { mergeKey: 'tempo' });
    expect(s.historyLabels().past.length).toBe(1);
    s.undo();
    expect(s.project.volume).toBe(0.78);
  });
});
