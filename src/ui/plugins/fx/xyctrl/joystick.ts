// X-Y Controller joystick input (FL's "Enable joystick controller"): while a
// project has an X-Y Controller with the joystick on, gamepad axes are polled
// every animation frame and move its goal (X / Y Level). Absolute axes set the
// goal from the stick position; relative ones move it at the joystick speed.

import { store } from '../../../../store';
import { setFxStateNoHistory } from '../../../../store/actions';
import { allFx } from '../../../../model/fx/hosted';
import { defaultJoystick, type XYJoystick } from '../../../../model/fx/plugins/xyctrl';
import type { Project } from '../../../../model/types';

export function gamepadNames(): string[] {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
  return [...navigator.getGamepads()].filter((g): g is Gamepad => !!g).map((g) => g.id);
}

interface Active { slotId: string; joy: XYJoystick }

let active: Active[] = [];
let raf = 0;
let last = 0;
let lastProject: Project | null = null;

function scan(p: Project): void {
  if (p === lastProject) return;
  lastProject = p;
  active = [];
  for (const s of allFx(p, 'xyctrl')) {
    const joy = { ...defaultJoystick(), ...((s.params.joy as Partial<XYJoystick>) ?? {}) };
    if (joy.enabled) active.push({ slotId: s.id, joy });
  }
  if (active.length && !raf) { last = performance.now(); raf = requestAnimationFrame(poll); }
}

function poll(t: number): void {
  raf = 0;
  if (!active.length) return;
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  const pad = navigator.getGamepads ? [...navigator.getGamepads()].find((g) => !!g) : undefined;
  if (pad) {
    for (const a of active) {
      const loc = store.project.mixer.tracks.flatMap((tr) => tr.slots).find((s) => s?.id === a.slotId);
      if (!loc) continue;
      const cur = { x: Number(loc.params.xLevel ?? 32768), y: Number(loc.params.yLevel ?? 32768) };
      const axis = (i: number) => { const v = pad.axes[i] ?? 0; return Math.abs(v) < 0.08 ? 0 : v; };
      const sx = axis(a.joy.xAxis), sy = -axis(a.joy.yAxis); // stick up = goal up
      const rate = (a.joy.speed / 100) * 2 * 65536 * dt; // full speed crosses the pad in half a second
      const nx = a.joy.xAbs ? ((sx + 1) / 2) * 65536 : cur.x + sx * rate;
      const ny = a.joy.yAbs ? ((sy + 1) / 2) * 65536 : cur.y + sy * rate;
      const cx = Math.round(Math.min(65536, Math.max(0, nx))), cy = Math.round(Math.min(65536, Math.max(0, ny)));
      if (cx !== cur.x || cy !== cur.y) setFxStateNoHistory(a.slotId, 'Joystick', (p) => { p.xLevel = cx; p.yLevel = cy; });
    }
  }
  raf = requestAnimationFrame(poll);
}

if (typeof window !== 'undefined') {
  scan(store.project);
  store.projectListeners.add((next) => scan(next));
}
