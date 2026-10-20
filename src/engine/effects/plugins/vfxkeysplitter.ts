// VFX Keyboard Splitter: note processing only (audio passes through).
// For every zone: k = keyboard envelope at key / 132 (the zone's key range and
// fades). Without Random a zone plays the note when k > 0 and scales its
// velocity by k (fades cross-fade the zones); with Random, k is the
// probability that the zone plays it. The velocity envelope at velocity / 128
// multiplies the velocity (Absolute: replaces it, the envelope's 0..1 =
// velocity 0..128). A zone whose resulting velocity is 0 does not play (so a
// velocity envelope can split by velocity). Each played copy goes to the
// zone's voice output (note.port = zone) transposed by the zone's transpose.

import type { EffectInstance, EffectModule } from '../types';
import { KEY_SPAN, ZONES, normalizeZones } from '../../../model/fx/plugins/vfxkeysplitter';
import { envAt } from '../../../model/fx/plugins/vfx/envelope';
import { clampKey, type VfxContext, type VfxNote } from '../../../model/fx/plugins/vfx/notes';

type P = Record<string, unknown>;

export function processNotes(notes: VfxNote[], p: P, ctx?: VfxContext): VfxNote[] {
  const zones = normalizeZones(p.zones);
  const rnd = ctx?.random ?? Math.random;
  const out: VfxNote[] = [];
  for (const n of notes) {
    for (let z = 0; z < ZONES; z++) {
      const zone = zones[z];
      const k = envAt(zone.key, Math.min(1, Math.max(0, n.key / KEY_SPAN)));
      if (k <= 0) continue;
      if (zone.random && rnd() >= k) continue;
      const v = envAt(zone.vel, Math.min(1, Math.max(0, n.vel / 128)));
      let vel = zone.abs ? v * 128 : n.vel * v;
      if (!zone.random) vel *= k;
      vel = Math.round(Math.min(128, Math.max(0, vel)));
      if (vel <= 0) continue;
      out.push({ ...n, key: clampKey(n.key + zone.transpose), vel, port: z });
    }
  }
  return out;
}

class KeySplitter implements EffectInstance {
  private p: P = {};
  setParams(p: unknown): void { this.p = (p ?? {}) as P; }
  process(): void { /* audio passes through */ }
  reset(): void {}
  notes(n: VfxNote[], ctx?: VfxContext): VfxNote[] { return processNotes(n, this.p, ctx); }
}

export const effect: EffectModule = { id: 'vfxkeysplitter', create: () => new KeySplitter() };
