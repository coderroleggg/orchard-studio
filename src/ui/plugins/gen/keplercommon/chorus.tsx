// The chorus buttons I and II (the forms' Mode1Btn / Mode2Btn on a ChorusModeSelect): they drive the four state chorus mode
// (0 Off, 1 Chorus 1, 2 Chorus 2, 3 Chorus 1 + 2). Like the Juno-6's interlocking buttons a click selects that chorus (or
// switches it off when it is the one running); Shift + click on the other one adds it (I + II).

import { useControl } from '../../../widgets/control';
import { useParam } from '../../kit';
import { PAD } from './skin';
import { LedView, PadView, hintOf } from './widgets';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Chorus mode value after a click on button `bit` (1 = I, 2 = II). */
export function chorusClick(mode: number, bit: number, shift: boolean): number {
  if (shift) return mode ^ bit;
  return mode === bit ? 0 : bit;
}

export function ChorusPads({ x1, x2, y, ledY, size = 33 }: { x1: number; x2: number; y: number; ledY: number; size?: number }) {
  const p = useParam('chorusMode');
  const { onContextMenu } = useControl(p.control, 'vertical');
  const mode = clamp(Math.round(p.value - p.def.min), 0, 3);
  const press = (bit: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    p.control.onBegin?.();
    p.set(p.def.min + chorusClick(mode, bit, e.shiftKey));
    p.control.onEnd?.();
  };
  const pad = (x: number, bit: number, color: string, label: string) => (
    <>
      <LedView x={x + (size - 17) / 2} y={ledY} w={17} h={12} on={(mode & bit) !== 0} />
      <PadView x={x} y={y} w={size} h={size} color={color} on={(mode & bit) !== 0} hint={() => hintOf(p)}
        handlers={{ onPointerDown: press(bit), onContextMenu }}>{label}</PadView>
    </>
  );
  return (
    <>
      {pad(x1, 1, PAD.yellow, 'I')}
      {pad(x2, 2, PAD.orange, 'II')}
    </>
  );
}
