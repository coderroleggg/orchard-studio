// NoteBook editor (FL: Fruity NoteBook, 297 x 211): one rich-text page out
// of 100 at a time, selected by the automatable page bar; read-only until the
// pencil enables editing. Rich text is kept as sanitised HTML; pasted rich
// text keeps its formatting but not pictures (as FL's notes).

import { useLayoutEffect, useRef, useState } from 'react';
import { notebookPages } from '../../../../model/fx/plugins/notebook';
import { sanitizeHtml } from '../../../../model/fx/plugins/htmlnotebook';
import { FxPanel, useFxEditor, useParam } from '../../kit';
import * as A from '../../../../store/actions';
import type { FxEditorModule } from '../../registry';
import { PageBar } from './PageBar';

/** True when a page has no visible content (it is then not stored). */
export function emptyHtml(html: string): boolean {
  return !/<img\b/i.test(html) && html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|\s/g, '') === '';
}

function NoteBookEditor() {
  const { slotId, params } = useFxEditor();
  const page = Math.round(useParam('page').value);
  const pages = notebookPages(params);
  const html = pages[String(page)] ?? '';
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);

  // load the page (and external changes such as undo) without disturbing the caret while typing
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clean = sanitizeHtml(html).html;
    if (clean !== shown.current) { el.innerHTML = clean; shown.current = clean; }
  }, [html, page]);

  const save = () => {
    const el = ref.current;
    if (!el) return;
    const clean = sanitizeHtml(el.innerHTML).html;
    shown.current = clean;
    A.editFx(slotId, 'Edit note', (p) => {
      const pg = { ...notebookPages(p) };
      if (emptyHtml(clean)) delete pg[String(page)];
      else pg[String(page)] = clean;
      p.pages = pg;
    }, `notebook:${slotId}:${page}`);
  };

  return (
    <FxPanel width={297} height={211} style={{ background: '#ccd1d5' }}>
      <style>{'.nb-rich p,.nb-rich div{margin:0}.nb-rich ul,.nb-rich ol{margin:0;padding-left:22px}'}</style>
      <div ref={ref} className="fxk-abs nb-rich" contentEditable={editing} suppressContentEditableWarning spellCheck={false}
        style={{
          left: 4, top: 4, width: 289, height: 187, overflowY: 'auto', overflowX: 'hidden', outline: 'none',
          font: '12px Arial, sans-serif', color: '#2d2c28', lineHeight: 1.15, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          cursor: editing ? 'text' : 'default', userSelect: 'text', WebkitUserSelect: 'text',
        }}
        onInput={save}
        onPaste={(e) => {
          if (!editing) return;
          e.preventDefault();
          const rich = e.clipboardData.getData('text/html');
          const text = e.clipboardData.getData('text/plain');
          if (rich) document.execCommand('insertHTML', false, sanitizeHtml(rich).html.replace(/<img\b[^>]*>/gi, ''));
          else document.execCommand('insertText', false, text);
        }}
        onDrop={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <PageBar y={192} width={274} editX={275} editing={editing}
        onToggleEdit={() => { const on = !editing; setEditing(on); if (on) setTimeout(() => ref.current?.focus(), 0); }} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'notebook', Editor: NoteBookEditor };
