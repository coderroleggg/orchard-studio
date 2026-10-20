// Slicex's sample properties dialog (FL: MEWAVPropForm, F2 / Format > Edit properties / right-click on the
// deck's properties): the deck's title, tempo and length in beats (linked through the sample length), FL's
// quick tempo guess; Accept applies them as one undo step. Drawn as an FL-style window over the editor.

import { useState } from 'react';
import { store } from '../../../../store';
import { sxGuessTempo } from '../../../../model/gen/plugins/slicex/ops';
import { deckEdit } from './actions';
import { cur } from './commands';

const fmt = (v: number, d = 3) => (v > 0 ? String(Number(v.toFixed(d))) : '');

export function PropsDialog({ slotId, onClose }: { slotId: string; onClose: () => void }) {
  const c = cur(slotId);
  const n = c.n, sr = c.audio?.sampleRate ?? 44100;
  const [title, setTitle] = useState(c.deck.title);
  const [tempo, setTempo] = useState(fmt(c.deck.tempo));
  const [beats, setBeats] = useState(fmt(c.deck.beats));
  const sec = n / sr;
  const onTempo = (s: string) => { setTempo(s); const t = parseFloat(s); if (t > 0 && n) setBeats(fmt((sec * t) / 60)); };
  const onBeats = (s: string) => { setBeats(s); const b = parseFloat(s); if (b > 0 && n) setTempo(fmt((b * 60) / sec)); };
  const guess = () => { const g = sxGuessTempo(n, sr, store.project.tempo); setTempo(fmt(g.tempo)); setBeats(fmt(g.beats)); };
  const accept = () => {
    const t = parseFloat(tempo), b = parseFloat(beats);
    deckEdit(slotId, c.d, 'Sample properties', (dk) => ({ ...dk, title: title.slice(0, 255), tempo: t > 0 && t < 1000 ? t : 0, beats: b > 0 ? b : 0 }), { dump: true });
    onClose();
  };
  const row = (label: string, el: React.ReactNode) => (
    <div className="sx-dlg-row"><span className="sx-dlg-lbl">{label}</span>{el}</div>
  );
  return (
    <div className="fxk-abs sx-dlg-back" style={{ left: 0, top: 0, right: 0, bottom: 0 }}
      onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); else if (e.key === 'Enter') accept(); }}>
      <div className="sx-dlg" style={{ left: 197, top: 180, width: 320 }}>
        <div className="sx-dlg-title">Sample properties - deck {c.d ? 'B' : 'A'}</div>
        <div className="sx-dlg-sec">Info</div>
        {row('Title', <input className="sx-dlg-in wide" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />)}
        <div className="sx-dlg-sec">Format</div>
        {row('Samplerate', <span className="sx-dlg-val">{c.audio ? `${sr} Hz, ${c.audio.channels.length > 1 ? 'stereo' : 'mono'}, ${n} samples` : '-'}</span>)}
        <div className="sx-dlg-sec">Tempo</div>
        {row('BPM', <input className="sx-dlg-in" value={tempo} onChange={(e) => onTempo(e.target.value)} inputMode="decimal" />)}
        {row('Length (beats)', <input className="sx-dlg-in" value={beats} onChange={(e) => onBeats(e.target.value)} inputMode="decimal" />)}
        <div className="sx-dlg-btns">
          <button className="sx-dlg-btn" disabled={!n} onClick={guess}>Quick guess</button>
          <span style={{ flex: 1 }} />
          <button className="sx-dlg-btn" onClick={onClose}>Cancel</button>
          <button className="sx-dlg-btn ok" onClick={accept}>Accept</button>
        </div>
      </div>
    </div>
  );
}
