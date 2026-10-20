// NoteBook 2 editor (FL: Fruity NoteBook 2, 297 x 211): one plain-text page
// out of 100, selected by the automatable page bar; read-only until the
// pencil enables editing; Ctrl+wheel changes the text size (saved).

import { useEffect, useRef, useState } from 'react';
import { notebookPages } from '../../../model/fx/plugins/notebook';
import { NOTEBOOK2_ZOOM } from '../../../model/fx/plugins/notebook2';
import { FxPanel, useFxEditor, useFxState, useParam } from '../kit';
import * as A from '../../../store/actions';
import type { FxEditorModule } from '../registry';
import { PageBar } from './notebook/PageBar';

function NoteBook2Editor() {
  const { slotId, params } = useFxEditor();
  const page = Math.round(useParam('page').value);
  const text = notebookPages(params)[String(page)] ?? '';
  const zoom = useFxState<number>('zoom', NOTEBOOK2_ZOOM.def);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Ctrl+wheel text size (a native non-passive listener: the browser would zoom the page otherwise)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const cur = zoomRef.current;
      const z = Math.max(NOTEBOOK2_ZOOM.min, Math.min(NOTEBOOK2_ZOOM.max, cur + (e.deltaY < 0 ? 1 : -1)));
      if (z !== cur) A.editFx(slotId, 'Text size', (p) => { p.zoom = z; }, `notebook2:${slotId}:zoom`);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [slotId]);
  return (
    <FxPanel width={297} height={211} style={{ background: '#ccd1d5' }}>
      <textarea ref={ref} className="fxk-abs" value={text} readOnly={!editing} spellCheck={false}
        style={{
          left: 0, top: 0, width: 297, height: 192, margin: 0, border: 'none', outline: 'none', resize: 'none',
          background: 'transparent', padding: '3px 7px', boxSizing: 'border-box', color: '#23221d',
          font: `300 ${zoom}px/${Math.round(zoom * 1.28)}px var(--font-ui)`, cursor: editing ? 'text' : 'default',
        }}
        onChange={(e) => {
          const v = e.target.value;
          A.editFx(slotId, 'Edit note', (p) => {
            const pg = { ...notebookPages(p) };
            if (v) pg[String(page)] = v; else delete pg[String(page)];
            p.pages = pg;
          }, `notebook2:${slotId}:${page}`);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <PageBar y={192} width={274} editX={276} editing={editing}
        onToggleEdit={() => { const on = !editing; setEditing(on); if (on) setTimeout(() => ref.current?.focus(), 0); }} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'notebook2', Editor: NoteBook2Editor };
