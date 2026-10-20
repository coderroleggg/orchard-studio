// Patcher "Surface" tab placeholder (see docs/research/fx/patcher.md).
import type { PatcherGraph } from '../../../../model/fx/plugins/patcher';

export function Surface({ width, height }: { slotId: string; graph: PatcherGraph; width: number; height: number }) {
  return <div className="ptc-surface" style={{ width, height }} />;
}
