// Standalone editor gallery for visual checks against FL's screenshots:
//   /?fxgallery=<plugin id>&scale=1.5[&p=<json params>]   one editor, top-left, at `scale`
//   /?fxgallery=all                                       every registered editor
// It renders the editor with default (or given) parameters and no audio.

import { FX_DEFS, defaultFxParams, fxDef } from '../../model/fx/registry';
import { defaultGenParams, genDef } from '../../model/gen/registry';
import { FxEditorContext, type FxEditorCtx } from './kit';
import { editorFor } from './registry';
import { genEditorFor } from './genRegistry';
import { GenericEditor, genericSize } from './GenericEditor';
import { EditorBoundary } from './EditorBoundary';

function One({ id, scale, params }: { id: string; scale: number; params?: Record<string, unknown> }) {
  // effects, then instruments (their editors read their plugin the same way)
  const fx = fxDef(id);
  const d = fx ?? genDef(id);
  const mod = fx ? editorFor(id) : genEditorFor(id);
  if (!d) return <div style={{ color: '#f66', padding: 8 }}>Unknown plugin: {id}</div>;
  const ctx: FxEditorCtx = { slotId: 'gallery:' + id, plugin: id, params: { ...(fx ? defaultFxParams(id) : defaultGenParams(id)), ...(params ?? {}) }, trackName: 'Insert 1', pluginName: d.name };
  const size = mod?.size ? mod.size(ctx.params) : mod ? { w: d.width, h: d.height } : genericSize(d.params.length);
  return (
    <FxEditorContext.Provider value={ctx}>
      <div style={{ width: size.w * scale, height: size.h * scale, overflow: 'hidden' }}>
        <div style={{ width: size.w, height: size.h, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          <EditorBoundary name={d.name} width={size.w} height={size.h}>
            {mod ? <mod.Editor /> : <GenericEditor />}
          </EditorBoundary>
        </div>
      </div>
    </FxEditorContext.Provider>
  );
}

export function FxGallery({ id, scale, params }: { id: string; scale: number; params?: Record<string, unknown> }) {
  if (id !== 'all') return <One id={id} scale={scale} params={params} />;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, padding: 16, background: '#2b2f32', minHeight: '100vh', alignItems: 'flex-start' }}>
      {FX_DEFS.filter((d) => d.id !== 'peq2').map((d) => (
        <div key={d.id}>
          <div style={{ color: '#ccc', font: '12px sans-serif', marginBottom: 4 }}>{d.name} ({d.id}){editorFor(d.id) ? '' : ' - generic'}</div>
          <One id={d.id} scale={scale} />
        </div>
      ))}
    </div>
  );
}
