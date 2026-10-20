// FL Studio Mobile Rack FX editor (575 x 605): the orange "Mobile Rack" title
// bar (rack menu), a scrolling column of module panels and the (+) Add
// Module button. Each panel has FL Studio Mobile's header: power switch,
// mixer button (module level / mix / pan), "FX <name>", preset selector
// ("Default") and the module menu (enable, minimise, move, insert, replace,
// copy / paste, delete), then the module's tabs and controls.

import { useEffect, useRef, useState } from 'react';
import * as A from '../../../../store/actions';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useFxEditor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import {
  MR_MIX_DEFAULT, MR_MODULES, mrDefaults, mrHeaderName, mrModuleDef, mrModules, type MrMod,
} from '../../../../model/fx/plugins/mobilerack';
import { MR_CATEGORIES } from '../../../../model/fx/plugins/mobilerack/modules';
import { MixKnob, ModuleBody } from './panels';
import './mobilerack.css';

type Draft = Record<string, unknown>;

let clipboard: { type: number; p: number[]; mx: number[] } | null = null;
let rackClipboard: { mods: Record<string, MrMod>; order: number[]; next: number } | null = null;

// ---- rack edits (one undo step each)

function edit(slotId: string, label: string, fn: (mods: Record<string, MrMod>, order: number[], p: Draft) => void): void {
  A.editFx(slotId, label, (p) => {
    if (!p.mods || typeof p.mods !== 'object') p.mods = {};
    if (!Array.isArray(p.order)) p.order = [];
    if (typeof p.next !== 'number') p.next = 1;
    fn(p.mods as Record<string, MrMod>, p.order as number[], p as Draft);
  });
}

function newModule(p: Draft, type: number, src?: { p: number[]; mx: number[] }): MrMod {
  const id = Math.max(1, Math.floor(p.next as number));
  p.next = id + 1;
  return { id, type, p: src ? [...src.p] : mrDefaults(type), mx: src ? [...src.mx] : [...MR_MIX_DEFAULT] };
}

function insertModule(slotId: string, type: number, at: number, src?: { p: number[]; mx: number[] }): void {
  edit(slotId, `Add ${mrModuleDef(type)?.name ?? 'module'}`, (mods, order, p) => {
    const m = newModule(p, type, src);
    mods[String(m.id)] = m;
    order.splice(Math.max(0, Math.min(order.length, at)), 0, m.id);
  });
}

function moduleList(onPick: (type: number) => void): MenuItem[] {
  return MR_CATEGORIES.map((cat) => ({
    label: cat,
    submenu: MR_MODULES.filter((d) => d.cat === cat).sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ label: d.name, hint: d.desc, onClick: () => onPick(d.type) })),
  }));
}

function moduleMenu(slotId: string, m: MrMod, index: number, count: number): MenuItem[] {
  const on = (m.p[0] ?? 1) >= 0.5;
  const name = mrModuleDef(m.type)?.name ?? 'module';
  return [
    { label: on ? 'Disable module' : 'Enable module', onClick: () => edit(slotId, `${on ? 'Disable' : 'Enable'} ${name}`, (mods) => { const x = mods[String(m.id)]; if (x) x.p[0] = on ? 0 : 1; }) },
    { label: m.min ? 'Maximize module' : 'Minimize module', onClick: () => edit(slotId, m.min ? 'Maximize module' : 'Minimize module', (mods) => { const x = mods[String(m.id)]; if (x) { if (x.min) delete x.min; else x.min = true; } }) },
    { label: 'Minimize all', onClick: () => edit(slotId, 'Minimize all', (mods) => { for (const x of Object.values(mods)) x.min = true; }) },
    { label: 'Maximize all', onClick: () => edit(slotId, 'Maximize all', (mods) => { for (const x of Object.values(mods)) delete x.min; }) },
    { separator: true },
    { label: 'Move up', disabled: index === 0, onClick: () => edit(slotId, 'Move module up', (_mods, order) => { const i = order.indexOf(m.id); if (i > 0) { order.splice(i, 1); order.splice(i - 1, 0, m.id); } }) },
    { label: 'Move down', disabled: index >= count - 1, onClick: () => edit(slotId, 'Move module down', (_mods, order) => { const i = order.indexOf(m.id); if (i >= 0 && i < order.length - 1) { order.splice(i, 1); order.splice(i + 1, 0, m.id); } }) },
    { separator: true },
    { label: 'Insert above', submenu: moduleList((t) => insertModule(slotId, t, index)) },
    { label: 'Insert below', submenu: moduleList((t) => insertModule(slotId, t, index + 1)) },
    {
      label: 'Replace module', submenu: moduleList((t) => edit(slotId, `Replace with ${mrModuleDef(t)?.name ?? 'module'}`, (mods, order, p) => {
        const i = order.indexOf(m.id);
        if (i < 0) return;
        const nm = newModule(p, t);
        delete mods[String(m.id)];
        mods[String(nm.id)] = nm;
        order[i] = nm.id;
      })),
    },
    { separator: true },
    { label: 'Copy module', onClick: () => { clipboard = { type: m.type, p: [...m.p], mx: [...(m.mx ?? MR_MIX_DEFAULT)] }; } },
    { label: 'Paste', disabled: !clipboard, onClick: () => { if (clipboard) insertModule(slotId, clipboard.type, index + 1, clipboard); } },
    { separator: true },
    { label: 'Delete module', onClick: () => edit(slotId, `Delete ${name}`, (mods, order) => { delete mods[String(m.id)]; const i = order.indexOf(m.id); if (i >= 0) order.splice(i, 1); }) },
  ];
}

function rackMenu(slotId: string, params: Record<string, unknown>): MenuItem[] {
  const count = mrModules(params).length;
  return [
    { label: 'Add module', submenu: moduleList((t) => insertModule(slotId, t, count)) },
    { separator: true },
    { label: 'Minimize all', onClick: () => edit(slotId, 'Minimize all', (mods) => { for (const x of Object.values(mods)) x.min = true; }) },
    { label: 'Maximize all', onClick: () => edit(slotId, 'Maximize all', (mods) => { for (const x of Object.values(mods)) delete x.min; }) },
    { separator: true },
    {
      label: 'Copy rack', onClick: () => {
        rackClipboard = structuredClone({ mods: (params.mods ?? {}) as Record<string, MrMod>, order: (params.order ?? []) as number[], next: Number(params.next) || 1 });
      },
    },
    {
      label: 'Paste rack', disabled: !rackClipboard, onClick: () => {
        const c = rackClipboard;
        if (!c) return;
        edit(slotId, 'Paste rack', (mods, order, p) => {
          for (const k of Object.keys(mods)) delete mods[k];
          Object.assign(mods, structuredClone(c.mods));
          order.length = 0; order.push(...c.order);
          p.next = c.next;
        });
      },
    },
    { label: 'Clear rack', onClick: () => edit(slotId, 'Clear rack', (mods, order) => { for (const k of Object.keys(mods)) delete mods[k]; order.length = 0; }) },
  ];
}

// ---- module panel

function ModulePanel({ m, index, count }: { m: MrMod; index: number; count: number }) {
  const { slotId } = useFxEditor();
  const def = mrModuleDef(m.type);
  const [tab, setTab] = useState<string | null>(def?.tabs?.[0] ?? null);
  const [mixOpen, setMixOpen] = useState(false);
  if (!def) return null;
  const on = (m.p[0] ?? 1) >= 0.5;
  const reset = () => edit(slotId, `${def.name}: Default`, (mods) => { const x = mods[String(m.id)]; if (x) { x.p = mrDefaults(m.type); x.mx = [...MR_MIX_DEFAULT]; } });
  return (
    <div className={'mr-mod' + (on ? '' : ' disabled')}>
      <div className="mr-head">
        <div className={'mr-power ' + (on ? 'on' : 'off')} data-mrctl="1"
          onPointerEnter={() => setHint(`${def.name}: ${on ? 'enabled' : 'bypassed'}`)} onPointerLeave={clearHint}
          onPointerDown={(e) => { e.stopPropagation(); edit(slotId, `${on ? 'Disable' : 'Enable'} ${def.name}`, (mods) => { const x = mods[String(m.id)]; if (x) x.p[0] = on ? 0 : 1; }); }}>
          <div className="dot" />
        </div>
        <div className={'mr-mixbtn' + (mixOpen ? ' open' : '')} title="Module mixer" onPointerDown={(e) => { e.stopPropagation(); setMixOpen(!mixOpen); }}>
          <svg width="22" height="22" viewBox="0 0 22 22">
            {[4, 11, 18].map((x, i) => <g key={x}><rect x={x - 0.75} y={2} width={1.5} height={18} fill="#fff" /><rect x={x - 3} y={[12, 5, 14][i]} width={6} height={3} rx={1} fill="#fff" /></g>)}
          </svg>
        </div>
        <div className="mr-name" onDoubleClick={() => edit(slotId, m.min ? 'Maximize module' : 'Minimize module', (mods) => { const x = mods[String(m.id)]; if (x) { if (x.min) delete x.min; else x.min = true; } })}>
          {mrHeaderName(m.type)}
        </div>
        <div className="mr-preset" onPointerDown={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, [{ label: 'Default', checked: true, radio: true, onClick: reset }], { minWidth: 120 });
        }}>
          <span>Default</span>
          <span className="arrow" onPointerDown={(e) => { e.stopPropagation(); reset(); }} />
        </div>
        <div className="mr-burger" onPointerDown={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, moduleMenu(slotId, m, index, count), { minWidth: 160 });
        }}>
          <svg width="20" height="20" viewBox="0 0 20 20">{[4, 10, 16].map((y) => <rect key={y} x={1} y={y - 1} width={18} height={2} fill="#fff" />)}</svg>
        </div>
      </div>
      {mixOpen && (
        <div className="mr-mixer">
          <MixKnob m={m} k={0} /><MixKnob m={m} k={1} /><MixKnob m={m} k={2} />
        </div>
      )}
      {!m.min && (
        <>
          {def.tabs && (
            <div className="mr-tabs">
              {def.tabs.map((t) => <div key={t} className={'mr-tab' + (t === tab ? ' sel' : '')} onPointerDown={(e) => { e.stopPropagation(); setTab(t); }}>{t}</div>)}
            </div>
          )}
          <div className="mr-body"><ModuleBody m={m} tab={tab} /></div>
        </>
      )}
    </div>
  );
}

// ---- editor

function MobileRackEditor() {
  const { slotId, params } = useFxEditor();
  const mods = mrModules(params);
  const scroll = useRef<HTMLDivElement>(null);
  // wheel over a control edits it instead of scrolling the rack
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('[data-mrctl]')) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const add = (e: React.PointerEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, moduleList((t) => insertModule(slotId, t, mods.length)), { minWidth: 140 });
  };
  return (
    <div className="mr-root">
      <div className="mr-title" onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, rackMenu(slotId, params)); }}
        onPointerDown={(e) => { if (e.button !== 0) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left + r.width / 2 - 70, r.bottom, rackMenu(slotId, params), { minWidth: 140 }); }}>
        Mobile Rack
      </div>
      <div className="mr-scroll" ref={scroll}>
        {mods.length === 0 && <div className="mr-empty">The rack is empty</div>}
        {mods.map((m, i) => <ModulePanel key={m.id} m={m} index={i} count={mods.length} />)}
        <div className="mr-add">
          <div className="btn" onPointerDown={add} onPointerEnter={() => setHint('Add a module to the end of the rack')} onPointerLeave={clearHint} />
          <div className="lbl" onPointerDown={add}>Add Module</div>
        </div>
      </div>
    </div>
  );
}

export const editor: FxEditorModule = {
  id: 'mobilerack',
  Editor: MobileRackEditor,
  menu: (slotId) => [
    { label: 'Clear rack', onClick: () => edit(slotId, 'Clear rack', (mods, order) => { for (const k of Object.keys(mods)) delete mods[k]; order.length = 0; }) },
  ],
};

