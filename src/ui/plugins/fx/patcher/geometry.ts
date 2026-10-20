// Patcher map geometry: node boxes, port positions and cable curves, in map
// units (node centres) and screen units (after the view transform).

import {
  IN, OUT, nodePorts, shownOuts, type LinkKind, type PatcherGraph, type PatcherView,
} from '../../../../model/fx/plugins/patcher';
import { iconSize } from './Hosted';

export interface Xf {
  /** Screen pixels per map unit, per axis (FL zooms each axis separately). */
  zx: number;
  zy: number;
  /** Map point at the view's top-left corner. */
  ox: number;
  oy: number;
}

export interface PortRef {
  node: string;
  kind: LinkKind;
  dir: 'in' | 'out';
  port: number;
}

export interface PortPos extends PortRef {
  x: number;
  y: number;
}

/** FL I/O node glyph box. */
export const IO_W = 46;
export const IO_H = 40;
export const PORT_R = 5;
export const PORT_GAP = 14;

/** Node icons keep their proportions: they scale with the smaller zoom axis. */
export const nodeScale = (xf: Xf): number => Math.min(xf.zx, xf.zy);

export function nodeCentre(g: PatcherGraph, id: string): { x: number; y: number } | null {
  if (id === IN) return g.io.in;
  if (id === OUT) return g.io.out;
  const m = g.modules[id];
  return m ? { x: m.x, y: m.y } : null;
}

export function nodeBox(g: PatcherGraph, id: string): { w: number; h: number } {
  if (id === IN || id === OUT) return { w: IO_W, h: IO_H };
  const m = g.modules[id];
  return m ? iconSize(m.plugin) : { w: 60, h: 40 };
}

export function toScreen(xf: Xf, x: number, y: number): { x: number; y: number } {
  return { x: (x - xf.ox) * xf.zx, y: (y - xf.oy) * xf.zy };
}

export function toMap(xf: Xf, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / xf.zx + xf.ox, y: sy / xf.zy + xf.oy };
}

/** The ports a node shows on one side, top to bottom, with their offsets from the node centre (node units). */
export function nodePortList(g: PatcherGraph, id: string, dir: 'in' | 'out', view: PatcherView): { kind: LinkKind; port: number; dx: number; dy: number }[] {
  const p = nodePorts(g, id);
  if (!p) return [];
  const list: { kind: LinkKind; port: number }[] = [];
  if (view.audio) {
    if (dir === 'out') for (const k of shownOuts(g, id, 'audio')) list.push({ kind: 'audio', port: k });
    else for (let k = 0; k < p.audioIn; k++) list.push({ kind: 'audio', port: k });
  }
  if (view.events) {
    if (dir === 'out') for (const k of shownOuts(g, id, 'events')) list.push({ kind: 'events', port: k });
    else for (let k = 0; k < p.eventsIn; k++) list.push({ kind: 'events', port: k });
  }
  const box = nodeBox(g, id);
  const edge = id === IN || id === OUT ? box.w / 2 + 6 : box.w / 2 + PORT_R + 2;
  const dx = dir === 'out' ? edge : -edge;
  const n = list.length;
  return list.map((q, i) => ({ ...q, dx, dy: (i - (n - 1) / 2) * PORT_GAP }));
}

/** Every visible port in screen coordinates. */
export function allPorts(g: PatcherGraph, xf: Xf, view: PatcherView, moved?: Map<string, { dx: number; dy: number }>): PortPos[] {
  const out: PortPos[] = [];
  const zn = nodeScale(xf);
  const ids = [IN, OUT, ...g.order.filter((id) => g.modules[id])];
  for (const id of ids) {
    const c = nodeCentre(g, id);
    if (!c) continue;
    const off = moved?.get(id);
    const s = toScreen(xf, c.x + (off?.dx ?? 0), c.y + (off?.dy ?? 0));
    for (const dir of ['in', 'out'] as const) {
      for (const q of nodePortList(g, id, dir, view)) out.push({ node: id, kind: q.kind, dir, port: q.port, x: s.x + q.dx * zn, y: s.y + q.dy * zn });
    }
  }
  return out;
}

export function findPort(ports: PortPos[], r: PortRef): PortPos | undefined {
  return ports.find((p) => p.node === r.node && p.kind === r.kind && p.dir === r.dir && p.port === r.port);
}

export interface Curve {
  d: string;
  mx: number;
  my: number;
  /** Unit tangent at the middle. */
  tx: number;
  ty: number;
}

/** FL's cable: a cubic with horizontal tangents at both ports. */
export function cable(x0: number, y0: number, x1: number, y1: number, zn: number): Curve {
  const k = Math.max(26 * zn, Math.abs(x1 - x0) * 0.5);
  const c0x = x0 + k, c1x = x1 - k;
  const mx = (x0 + 3 * c0x + 3 * c1x + x1) / 8, my = (y0 + 3 * y0 + 3 * y1 + y1) / 8;
  let tx = x1 + c1x - c0x - x0, ty = 2 * (y1 - y0);
  const l = Math.hypot(tx, ty) || 1;
  tx /= l; ty /= l;
  return { d: `M${x0.toFixed(1)} ${y0.toFixed(1)} C${c0x.toFixed(1)} ${y0.toFixed(1)} ${c1x.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`, mx, my, tx, ty };
}

/** Workspace size (map units): the view area at 100%, grown to hold every node. */
export function workspace(g: PatcherGraph, vw: number, vh: number): { w: number; h: number } {
  let w = vw, h = vh;
  const grow = (x: number, y: number, bw: number, bh: number) => {
    w = Math.max(w, x + bw / 2 + 90);
    h = Math.max(h, y + bh / 2 + 60);
  };
  grow(g.io.in.x, g.io.in.y, IO_W, IO_H);
  grow(g.io.out.x, g.io.out.y, IO_W, IO_H);
  for (const id of g.order) {
    const m = g.modules[id];
    if (!m) continue;
    const b = iconSize(m.plugin);
    grow(m.x, m.y, b.w, b.h);
  }
  return { w, h };
}
