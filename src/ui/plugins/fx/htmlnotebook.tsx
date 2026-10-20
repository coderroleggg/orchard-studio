// HTML NoteBook editor (FL: Fruity HTML NoteBook, 297 x 288): a document
// view above FL's dark bottom panel (open, back, forward, URL field). Pages
// are always sanitised (no scripts, handlers or external loads); links are
// handled here: fragments scroll, built-in and opened documents navigate,
// anything on the web shows a notice instead of loading.

import { useRef, useState } from 'react';
import {
  HTML_BUILTIN, HTML_DEFAULT_URL, htmlDocument, safeHref, sanitizeHtml,
} from '../../../model/fx/plugins/htmlnotebook';
import { FxPanel, useFxEditor, useFxState } from '../kit';
import * as A from '../../../store/actions';
import { clearHint, flashHint, setHint } from '../../hint';
import type { FxEditorModule } from '../registry';

const MAX_DOC = 4 * 1024 * 1024;

/** Resolve a link of the current document to a URL (relative names resolve next to it). */
function resolve(href: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : 'file:///';
  return dir + href.replace(/^\.\//, '');
}

function HtmlNoteBookEditor() {
  const { slotId } = useFxEditor();
  const url = useFxState<string>('url', HTML_DEFAULT_URL);
  const stored = useFxState<string>('html', '');
  const storedUrl = useRef(url);
  const [hist, setHist] = useState<{ list: string[]; at: number }>({ list: [url], at: 0 });
  const [edit, setEdit] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // the opened document belongs to the URL it was opened as
  if (stored && !HTML_BUILTIN[url] && storedUrl.current !== url && !/^https?:/i.test(url)) storedUrl.current = url;
  const doc = htmlDocument(url, { url: storedUrl.current, html: stored });

  const go = (to: string, push = true) => {
    const target = to.trim();
    if (!target) return;
    if (push) setHist((h) => ({ list: [...h.list.slice(0, h.at + 1), target], at: h.at + 1 }));
    A.editFx(slotId, 'HTML NoteBook: open page', (p) => { p.url = target; });
    view.current?.scrollTo(0, 0);
  };
  const back = () => { if (hist.at > 0) { const at = hist.at - 1; setHist({ ...hist, at }); go(hist.list[at], false); } };
  const fwd = () => { if (hist.at < hist.list.length - 1) { const at = hist.at + 1; setHist({ ...hist, at }); go(hist.list[at], false); } };

  const openFile = async (f: File) => {
    let text = await f.text();
    if (!/\.html?$/i.test(f.name)) text = `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    const s = sanitizeHtml(text);
    let body = `<body${s.bg ? ` bgcolor="${s.bg}"` : ''}${s.text ? ` text="${s.text}"` : ''}>${s.html}</body>`;
    if (body.length > MAX_DOC) { body = body.replace(/<img\b[^>]*>/gi, ''); flashHint('HTML NoteBook: large images were left out'); }
    const target = `file:///${f.name}`;
    storedUrl.current = target;
    setHist((h) => ({ list: [...h.list.slice(0, h.at + 1), target], at: h.at + 1 }));
    A.editFx(slotId, 'HTML NoteBook: open document', (p) => { p.url = target; p.html = body; });
  };

  const btn = (x: number, w: number, hint: string, onClick: () => void, icon: React.ReactNode, enabled = true) => (
    <div className="fxk-abs" style={{ left: x, top: 261, width: w, height: 27, cursor: 'default', opacity: enabled ? 1 : 0.45 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={w} height={27} viewBox={`0 0 ${w} 27`} style={{ display: 'block' }}>{icon}</svg>
    </div>
  );

  return (
    <FxPanel width={297} height={288} style={{ background: '#292e32' }}>
      <div ref={view} className="fxk-abs hnb-view"
        style={{
          left: 0, top: 0, width: 297, height: 260, overflow: 'auto', background: doc.bg ?? '#ffffff', color: doc.text ?? '#000000',
          font: '16px "Times New Roman", Times, serif', padding: 8, boxSizing: 'border-box', userSelect: 'text', WebkitUserSelect: 'text',
        }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest('a[data-href]') as HTMLElement | null;
          if (!a) return;
          e.preventDefault();
          const href = safeHref(a.dataset.href ?? '');
          if (!href) return;
          if (href.startsWith('#')) {
            view.current?.querySelector(`#hnb-${CSS.escape(href.slice(1))}`)?.scrollIntoView();
            return;
          }
          go(resolve(href, url));
        }}
        onPointerDown={(e) => e.stopPropagation()}
        dangerouslySetInnerHTML={{ __html: doc.html }}
      />
      <style>{'.hnb-view a[data-href]{color:#0b3d91;text-decoration:underline;cursor:pointer}.hnb-view img{max-width:100%}.hnb-view p{margin:1em 0}'}</style>
      {btn(0, 24, 'Open document...', () => file.current?.click(),
        <path d="M6 9.5 H10.2 L11.6 11 H18 V18.5 H6 Z" fill="none" stroke="#dfe5e9" strokeWidth={1.2} strokeLinejoin="round" />)}
      {btn(24, 16, 'Back', back, <path d="M10.5 9 L5.5 13.5 L10.5 18 Z" fill="#dfe5e9" />, hist.at > 0)}
      {btn(40, 21, 'Forward', fwd, <path d="M4.5 9 L9.5 13.5 L4.5 18 Z" fill="#dfe5e9" />, hist.at < hist.list.length - 1)}
      <input className="fxk-abs" value={edit ?? url} spellCheck={false}
        style={{
          left: 61, top: 266, width: 231, height: 17, boxSizing: 'border-box', margin: 0, padding: '0 4px',
          background: '#292e32', color: '#e5ebef', font: '11px var(--font-ui)', borderRadius: 3, outline: 'none',
          border: `1px solid ${focus ? '#0f61b2' : '#41484d'}`,
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => { setFocus(false); setEdit(null); }}
        onChange={(e) => setEdit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { go(edit ?? url); setEdit(null); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setEdit(null); (e.target as HTMLInputElement).blur(); }
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <input ref={file} type="file" accept=".html,.htm,.txt,text/html,text/plain" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = ''; }} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'htmlnotebook', Editor: HtmlNoteBookEditor };
