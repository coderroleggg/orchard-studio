// The PLUGIN tab of an instrument channel's settings window: the instrument's
// editor (src/ui/plugins/gen/<id>, or the generic knob editor) at FL's editor
// size, scaled to the window, inside the effect kit's FxEditorContext with
// slotId "ch:<channel id>". Plus the wrapper's preset bar, MIDI input port and
// options menu items.

import { useProject } from '../../store';
import * as A from '../../store/actions';
import type { Channel } from '../../model/types';
import { defaultGenParams, genDef, genPresetState } from '../../model/gen/registry';
import { channelSlotId } from '../../model/gen/ids';
import { FxEditorContext, type FxEditorCtx } from '../plugins/kit';
import { genEditorFor } from '../plugins/genRegistry';
import { GenericEditor, genericSize } from '../plugins/GenericEditor';
import { EditorBoundary } from '../plugins/EditorBoundary';
import { PortBox, PresetBar, Scaled, portMenu, presetMenu } from '../plugins/PluginWindows';
import type { MenuItem } from '../widgets/ContextMenu';
import { flashHint } from '../hint';

/** The instrument editor's panel size for the channel's current plugin state. */
export function genEditorSize(ch: Channel): { w: number; h: number } {
  const id = ch.plugin?.id ?? '';
  const def = genDef(id);
  const mod = genEditorFor(id);
  if (mod?.size && ch.plugin) return mod.size(ch.plugin.params);
  if (mod || !def) return { w: def?.width ?? 400, h: def?.height ?? 200 };
  return genericSize(def.params.length);
}

/** The PLUGIN tab body. */
export function GenPluginTab({ ch }: { ch: Channel }) {
  const params = useProject((p) => p.channels.find((c) => c.id === ch.id)?.plugin?.params ?? null);
  const plugin = ch.plugin?.id ?? '';
  const def = genDef(plugin);
  const mod = genEditorFor(plugin);
  const size = genEditorSize(ch);
  if (!params) return null;
  const ctx: FxEditorCtx = {
    slotId: channelSlotId(ch.id), plugin, params: params as Record<string, unknown>,
    trackName: ch.name, pluginName: def?.name ?? plugin,
  };
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <FxEditorContext.Provider value={ctx}>
        <Scaled w={size.w} h={size.h}>
          <EditorBoundary name={def?.name ?? plugin} width={size.w} height={size.h}>
            {mod ? <mod.Editor /> : <GenericEditor />}
          </EditorBoundary>
        </Scaled>
      </FxEditorContext.Provider>
    </div>
  );
}

/** Load factory preset `i` (wrapping around) into the channel's instrument: one undo step. */
function loadPreset(ch: Channel, i: number): void {
  const plugin = ch.plugin?.id ?? '';
  const presets = genDef(plugin)?.presets ?? [];
  const pr = presets[((i % presets.length) + presets.length) % presets.length];
  if (!pr) return;
  const fresh = genPresetState(plugin, pr, ch.plugin?.params);
  A.editFx(channelSlotId(ch.id), `Preset: ${pr.name}`, (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
}

/** The window's title-bar tools: the MIDI input port (when set) and the preset bar. */
export function GenToolbar({ ch }: { ch: Channel }) {
  const plugin = ch.plugin?.id ?? '';
  const presets = genDef(plugin)?.presets ?? [];
  const port = ch.plugin?.midiPort ?? -1;
  const current = typeof ch.plugin?.params.__preset === 'string' ? ch.plugin.params.__preset as string : '';
  const portBox = port >= 0 ? <PortBox port={port} set={(p) => A.setGenMidiPort(ch.id, p)} /> : null;
  if (presets.length) return <PresetBar names={presets.map((p) => p.name)} current={current} load={(i) => loadPreset(ch, i)} before={portBox} />;
  return portBox ? <div className="fxw-presets">{portBox}</div> : null;
}

/** The plugin's items in the channel window's options menu (FL's wrapper menu). */
export function genMenuItems(ch: Channel): MenuItem[] {
  const plugin = ch.plugin?.id ?? '';
  const def = genDef(plugin);
  const presets = def?.presets ?? [];
  const mod = genEditorFor(plugin);
  const slotId = channelSlotId(ch.id);
  const current = typeof ch.plugin?.params.__preset === 'string' ? ch.plugin.params.__preset as string : '';
  const port = ch.plugin?.midiPort ?? -1;
  return [
    ...(presets.length ? [{ label: 'Presets', submenu: presetMenu(presets.map((p) => p.name), presets.findIndex((p) => p.name === current), (i) => loadPreset(ch, i)) }] : []),
    { label: 'MIDI input port', submenu: portMenu(port, (p) => A.setGenMidiPort(ch.id, p)) },
    ...(mod?.menu ? [{ separator: true } as MenuItem, ...mod.menu(slotId)] : []),
    {
      label: `Reset ${def?.name ?? 'plugin'}`, onClick: () => {
        const fresh = defaultGenParams(plugin);
        A.editFx(slotId, 'Reset plugin', (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
        flashHint(`${def?.name ?? plugin} reset`);
      },
    },
  ];
}
