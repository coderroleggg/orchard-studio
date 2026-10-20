// Fallback editor for plugins (effects and instruments) without a bespoke one: a knob per parameter.

import { FxPanel, Label, Wheel, pluginDefOf, useFxEditor } from './kit';

export const GENERIC_COLS = 8;

export function genericSize(n: number): { w: number; h: number } {
  const cols = Math.min(GENERIC_COLS, Math.max(1, n));
  return { w: Math.max(260, cols * 62 + 16), h: Math.ceil(Math.max(1, n) / cols) * 76 + 40 };
}

export function GenericEditor() {
  const c = useFxEditor();
  const d = pluginDefOf(c);
  const params = d?.params ?? [];
  const { w, h } = genericSize(params.length);
  return (
    <FxPanel width={w} height={h}>
      <Label x={0} y={6} w={w} h={16} size={12}>{d?.name ?? c.plugin}</Label>
      {params.map((p, i) => {
        const col = i % GENERIC_COLS, row = Math.floor(i / GENERIC_COLS);
        const x = 12 + col * 62, y = 30 + row * 76;
        return (
          <div key={p.key}>
            <Wheel k={p.key} x={x + 8} y={y} size={42} color="#9bd35a" />
            <Label x={x - 4} y={y + 46} w={66} h={14} size={9}>{p.name}</Label>
          </div>
        );
      })}
    </FxPanel>
  );
}
