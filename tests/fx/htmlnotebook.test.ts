import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import { HTML_DEFAULT_URL, htmlDocument, safeHref, sanitizeHtml } from '../../src/model/fx/plugins/htmlnotebook';
import { render, sine } from './util';

const clean = (s: string) => sanitizeHtml(s).html;

describe('HTML NoteBook', () => {
  it('is registered without parameters, with FL default URL and factory presets', () => {
    const d = fxDef('htmlnotebook')!;
    expect([d.width, d.height, d.category, d.params.length]).toEqual([297, 288, 'Visual', 0]);
    expect(defaultFxParams('htmlnotebook')).toEqual({ url: 'file:///DefaultHtml.html', html: '' });
    expect(d.presets!.map((p) => p.name)).toEqual(['Default', 'FL Studio news', 'Google search']);
    expect(d.presets![2].params.url).toBe('http://www.google.com/');
  });

  it('passes audio through untouched', () => {
    const fx = createEffect('htmlnotebook', 48000, 128);
    const x = sine(440, 0.02);
    expect(render(fx, x)[0]).toEqual(x);
  });

  it('removes scripts, styles, frames, forms and plug-ins with their content', () => {
    const out = clean('<p>a</p><script>alert(1)</script><SCRIPT src=x></SCRIPT><style>p{background:url(x)}</style>'
      + '<iframe src="http://x"></iframe><object data=x></object><embed src=x><form><input value=1><button>b</button></form>'
      + '<svg><script>alert(2)</script></svg><noscript><img src=x></noscript><p>b</p>');
    expect(out).toBe('<p>a</p><p>b</p>');
  });

  it('removes event handlers and dangerous URLs, keeps formatting', () => {
    expect(clean('<b onclick="x()" onmouseover=y>bold</b>')).toBe('<b>bold</b>');
    expect(clean('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(clean('<a href=" jav&#x61;script:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(clean('<a href="vbscript:x">x</a><a href="data:text/html,<script>">y</a>')).toBe('<a>x</a><a>y</a>');
    expect(clean('<a href="http://example.com/a?b=1&c=2">x</a>')).toBe('<a data-href="http://example.com/a?b=1&amp;c=2">x</a>');
    expect(clean('<font face="Arial" size=2 color="#ff0000">t</font>')).toBe('<font face="Arial" size="2" color="#ff0000">t</font>');
    expect(clean('<p align="center" style="color:red;position:fixed;font-size:12px">t</p>')).toBe('<p align="center">t</p>');
    expect(clean('<p style="color:red;font-size:12px">t</p>')).toBe('<p style="color:red;font-size:12px">t</p>');
    expect(clean('<div style="background:url(http://x/y.png)">t</div>')).toBe('<div>t</div>');
    expect(clean('<div style="width:expression(alert(1))">t</div>')).toBe('<div>t</div>');
  });

  it('never loads external content: only inline data: images survive', () => {
    expect(clean('<img src="http://x/y.png"><img src="//x/y.png" onerror="z()">')).toBe('');
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    expect(clean(`<img src="${data}" alt="logo">`)).toBe(`<img src="${data}" alt="logo">`);
    expect(clean('<link rel=stylesheet href="http://x/s.css"><meta http-equiv="refresh" content="0;url=http://x">')).toBe('');
    expect(clean('<base href="http://x/"><p>t</p>')).toBe('<p>t</p>');
  });

  it('prefixes ids so documents cannot shadow window globals, and stays stable when re-sanitised', () => {
    expect(clean('<div id="__prKey">a</div><a name="top">b</a>')).toBe('<div id="hnb-__prKey">a</div><a id="hnb-top">b</a>');
    const once = clean('<p id="x" style="color:blue">a &amp; b &lt; c</p><a href="#top">t</a> 1 > 0 <img src=x>');
    expect(clean(once)).toBe(once);
  });

  it('keeps text, escapes stray brackets, drops comments and unknown tags', () => {
    expect(clean('a < b and c > d')).toBe('a &lt; b and c &gt; d');
    expect(clean('<!-- hidden <script>x</script> --><blink>t</blink><custom-el>u</custom-el>')).toBe('tu');
    expect(sanitizeHtml('<body bgcolor="#CCD1D5" text="black" onload="x()"><p>t</p></body>')).toEqual({ html: '<p>t</p>', bg: '#CCD1D5', text: 'black' });
  });

  it('serves built-in pages, the opened document, and a notice instead of loading the web', () => {
    expect(htmlDocument(HTML_DEFAULT_URL).html).toContain('NOTEBOOK');
    expect(htmlDocument(HTML_DEFAULT_URL).bg).toBe('#CCD1D5');
    expect(htmlDocument('file:///Info.html').html).toContain('HTML NoteBook');
    expect(htmlDocument('file:///notes.html', { url: 'file:///notes.html', html: '<p>mine</p>' }).html).toBe('<p>mine</p>');
    const notice = htmlDocument('http://www.google.com/').html;
    expect(notice).toContain('http://www.google.com/');
    expect(notice).not.toContain('data-href');
    expect(safeHref('#frag')).toBe('#frag');
    expect(safeHref('Info.html')).toBe('Info.html');
  });
});
