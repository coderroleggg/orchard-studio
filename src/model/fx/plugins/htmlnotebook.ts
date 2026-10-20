// HTML NoteBook (FL: Fruity HTML NoteBook): an HTML viewer with an open
// button, back / forward and a URL field. No parameters. FL saves only the
// document URL (default "file:///DefaultHtml.html", next to the plugin); in a
// browser a local file cannot be re-read later, so an opened document is also
// kept (sanitised) in the state. Nothing is ever loaded from outside: no
// scripts, no event handlers, no external images, styles or pages.
// Form: 297 x 288 (view 297 x 260, bottom panel 28 px).

import type { FxPluginDef } from '../types';

export const HTML_DEFAULT_URL = 'file:///DefaultHtml.html';
export const HTML_INFO_URL = 'file:///Info.html';

/** Built-in documents (our own content, standing in for the files next to FL's plugin). */
export const HTML_BUILTIN: Record<string, string> = {
  [HTML_DEFAULT_URL]: `<body bgcolor="#CCD1D5"><p align="center"><br><br>
<a href="Info.html" style="color:#4f555a;text-decoration:none;font-family:Helvetica Neue,Arial,sans-serif;font-size:23px;font-weight:300;letter-spacing:0.5px;line-height:27px">HTML<br>NOTEBOOK</a></p></body>`,
  [HTML_INFO_URL]: `<body bgcolor="#CCD1D5"><p align="left" style="font-family:Tahoma,Verdana,sans-serif;font-size:11px;color:#202427;line-height:15px">
The <b>HTML NoteBook</b> shows <b>HTML</b> documents and does not allow editing.<br><br>
Click the folder button to open a document. It is shown without scripts, plug-ins,
forms or anything loaded from the internet, and links to the web are not followed.<br><br>
<a href="DefaultHtml.html">Back to the start page</a></p></body>`,
};

export interface SanitizedHtml {
  html: string;
  /** <body bgcolor> / <body text> of the document, if safe. */
  bg?: string;
  text?: string;
}

const ALLOWED = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite',
  'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'label', 'li', 'main', 'mark',
  'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);
/** Elements dropped together with everything inside them. */
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'noembed', 'noframes',
  'template', 'svg', 'math', 'title', 'head', 'textarea', 'select', 'option', 'button', 'canvas', 'video', 'audio',
  'picture', 'xml', 'portal', 'dialog',
]);
/** Void elements that are removed (they have no content to skip). */
const DROP_VOID = new Set(['embed', 'source', 'track', 'link', 'meta', 'base', 'param', 'input', 'keygen', 'area', 'image']);
const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr']);
const COMMON = ['align', 'valign', 'title', 'dir', 'lang', 'id', 'width', 'height', 'bgcolor', 'color', 'style'];
const ATTRS: Record<string, string[]> = {
  a: ['href', 'data-href', 'name'], font: ['face', 'size', 'color'], img: ['src', 'alt', 'border', 'hspace', 'vspace'],
  table: ['border', 'cellpadding', 'cellspacing'], td: ['colspan', 'rowspan', 'nowrap'], th: ['colspan', 'rowspan', 'nowrap'],
  col: ['span'], colgroup: ['span'], ol: ['start', 'type', 'reversed'], ul: ['type'], li: ['value', 'type'],
  q: ['cite'], blockquote: ['cite'], time: ['datetime'], details: ['open'],
};
const STYLE_PROPS = new Set([
  'color', 'background-color', 'background', 'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant',
  'text-align', 'text-decoration', 'text-indent', 'text-transform', 'line-height', 'letter-spacing', 'word-spacing',
  'white-space', 'vertical-align', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top', 'border-right', 'border-bottom',
  'border-left', 'border-color', 'border-style', 'border-width', 'border-collapse', 'border-spacing', 'border-radius',
  'width', 'height', 'max-width', 'min-width', 'list-style', 'list-style-type', 'display', 'float', 'clear', 'opacity',
  'text-shadow', 'direction',
]);
const BAD_CSS = /url\s*\(|image-set|expression|javascript|vbscript|@import|behavior|binding|[<>\\]|position|var\s*\(/i;
const SAFE_VALUE = /^[\w\s#%,.+-]*$/;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Link targets that may stay: fragments, relative paths, http(s) and mailto (never followed automatically). */
export function safeHref(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const v = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]+/g, '');
  if (!v) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!scheme) return v;
  return /^(https?|mailto|file)$/i.test(scheme[1]) ? v : null;
}

function safeSrc(raw: string): string | null {
  const v = decodeEntities(raw).replace(/\s+/g, '');
  return /^data:image\/(png|gif|jpe?g|webp|bmp);base64,[a-z0-9+/=]+$/i.test(v) ? v : null;
}

function safeStyle(raw: string): string | null {
  const v = decodeEntities(raw);
  if (BAD_CSS.test(v)) return null;
  const out: string[] = [];
  for (const decl of v.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !val) continue;
    if (prop === 'display' && !/^(block|inline|inline-block|none|list-item|table|table-row|table-cell)$/i.test(val)) continue;
    out.push(`${prop}:${val}`);
  }
  return out.length ? out.join(';') : null;
}

const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Allow-list HTML sanitiser (string based, so it also runs without a DOM):
 * only formatting elements and attributes survive, every on* handler, script,
 * style sheet, frame, form and plug-in is removed, URLs are limited to links
 * (never followed automatically) and inline data: images, and inline styles
 * lose anything that could load or run something.
 */
export function sanitizeHtml(input: string): SanitizedHtml {
  const s = String(input ?? '');
  const out: string[] = [];
  const res: SanitizedHtml = { html: '' };
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out.push(s.slice(i).replace(/>/g, '&gt;')); break; }
    if (lt > i) out.push(s.slice(i, lt).replace(/>/g, '&gt;'));
    i = lt;
    const rest = s.slice(i, i + 8);
    if (rest.startsWith('<!--')) { const e = s.indexOf('-->', i + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (rest.startsWith('<!') || rest.startsWith('<?')) { const e = s.indexOf('>', i); i = e < 0 ? s.length : e + 1; continue; }
    const m = TAG.exec(s.slice(i));
    if (!m) { out.push('&lt;'); i++; continue; }
    i += m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (DROP_VOID.has(name)) continue;
    if (DROP.has(name)) {
      if (!closing && !m[0].endsWith('/>')) {
        const end = new RegExp(`</${name}\\s*>`, 'i').exec(s.slice(i));
        i = end ? i + end.index + end[0].length : s.length;
      }
      continue;
    }
    if (name === 'body' && !closing) {
      for (const a of m[3].matchAll(ATTR)) {
        const an = a[1].toLowerCase(), av = a[2] ?? a[3] ?? a[4] ?? '';
        if ((an === 'bgcolor' || an === 'text') && SAFE_VALUE.test(av)) res[an === 'bgcolor' ? 'bg' : 'text'] = av.trim();
      }
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (closing) { if (!VOID.has(name)) out.push(`</${name}>`); continue; }
    const allowed = new Set([...COMMON, ...(ATTRS[name] ?? [])]);
    let attrs = '';
    let anchor = '';
    for (const a of m[3].matchAll(ATTR)) {
      const an = a[1].toLowerCase();
      if (an.startsWith('on') || !allowed.has(an)) continue;
      const raw = a[2] ?? a[3] ?? a[4] ?? '';
      // ids and anchor names are prefixed so a document can never shadow window globals (DOM clobbering)
      if (an === 'id' || an === 'name') {
        const v = decodeEntities(raw).trim();
        if (/^[\w-]{1,64}$/.test(v) && !anchor) anchor = v.startsWith('hnb-') ? v.slice(4) : v;
        continue;
      }
      let v: string | null;
      if (an === 'href' || an === 'data-href') v = safeHref(raw);
      else if (an === 'src') v = safeSrc(raw);
      else if (an === 'style') v = safeStyle(raw);
      else if (an === 'cite') v = null;
      else v = SAFE_VALUE.test(decodeEntities(raw)) ? decodeEntities(raw) : null;
      if (v === null) continue;
      // links keep their target in data-href: nothing in the page is natively navigable
      if ((an === 'href' || an === 'data-href') && attrs.includes(' data-href=')) continue;
      attrs += ` ${an === 'href' ? 'data-href' : an}="${escAttr(v)}"`;
    }
    if (anchor) attrs += ` id="hnb-${anchor}"`;
    if (name === 'img' && !/ src="/.test(attrs)) continue; // no source we may load
    out.push(`<${name}${attrs}>`);
  }
  res.html = out.join('');
  return res;
}

/** The document for a URL: built-in pages, the stored (opened) document, or a notice for anything external. */
export function htmlDocument(url: string, stored?: { url?: string; html?: string }): SanitizedHtml {
  const key = url.trim();
  const builtin = HTML_BUILTIN[key] ?? HTML_BUILTIN[`file:///${key.replace(/^\.?\/*/, '')}`];
  if (builtin) return sanitizeHtml(builtin);
  if (stored?.html && stored.url === key) return sanitizeHtml(stored.html);
  const shown = key.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return sanitizeHtml(`<body bgcolor="#CCD1D5"><p style="font-size:11px;color:#202427">${shown || '(no document)'}</p>
<p style="font-size:11px;color:#202427">This document is not available here: pages from the internet and files that
were not opened in this project are not loaded. Use the folder button to open an HTML file.</p></body>`);
}

export const def: FxPluginDef = {
  id: 'htmlnotebook',
  name: 'HTML NoteBook',
  category: 'Visual',
  width: 297,
  height: 288,
  description: 'HTML document viewer',
  params: [],
  state: () => ({ url: HTML_DEFAULT_URL, html: '' }),
  normalize: (p) => ({ ...p, url: typeof p.url === 'string' ? p.url : HTML_DEFAULT_URL, html: typeof p.html === 'string' ? p.html : '' }),
  // FL's factory presets: document URLs (read with flfxhost)
  presets: [
    { name: 'Default', params: { url: HTML_DEFAULT_URL, html: '' } },
    { name: 'FL Studio news', params: { url: 'http://www.image-line.com/documents/news.php', html: '' } },
    { name: 'Google search', params: { url: 'http://www.google.com/', html: '' } },
  ],
};
