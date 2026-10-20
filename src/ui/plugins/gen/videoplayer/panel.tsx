// The Video Player's window content (FL's SynthPanel, 410 x 453 at its default
// size): the picture (a canvas the controller paints the <video> element's
// frames into) with FL's 100 px control panel below it, or floating over it
// and shown on mouse-over (Options > Dock control panel). Used by the channel's
// PLUGIN tab and by the detached window, at any size: the picture takes what
// the panel leaves. Control positions are the form's (left items from the
// left edge, the volume wheel and mute button, the end time from the right
// edge, the transport centred).

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useFxEditor, useNoScrollWheel, useParam } from '../../kit';
import { useControl } from '../../../widgets/control';
import { openMenu } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { subscribeLive, useLive } from '../../../../audio/live';
import * as A from '../../../../store/actions';
import { formatVideoTime, playRange, timeDialogTitle, vpState } from '../../../../model/gen/plugins/videoplayer';
import type { VideoController, VideoTime } from './controller';
import { loadVideoFile, pickVideoFile } from './load';
import { SetTimeDialog } from './dialog';
import { MAX_AUDIO_SECONDS } from './media';
import { PANEL_H, optionsMenu } from './menus';
import * as G from './glyphs';
import './videoplayer.css';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------ small parts

interface BtnProps {
  x: number;
  y: number;
  w: number;
  h: number;
  cls?: string;
  hint?: string;
  onClick: (e: React.PointerEvent) => void;
  onContext?: (e: React.MouseEvent) => void;
  style?: CSSProperties;
  children: ReactNode;
}

function Btn({ x, y, w, h, cls, hint, onClick, onContext, style, children }: BtnProps) {
  return (
    <div className={'vp-btn' + (cls ? ' ' + cls : '')} style={{ left: x, top: y, width: w, height: h, ...style }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext?.(e); }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}

interface TimeLabelProps {
  x: number;
  y: number;
  w: number;
  align: 'l' | 'r' | 'c';
  text: string;
  hint: string;
  onClick?: () => void;
  onContext: () => void;
}

function TimeLabel({ x, y, w, align, text, hint, onClick, onContext }: TimeLabelProps) {
  return (
    <div className={`vp-time ${align}`} style={{ left: x, top: y, width: w, textAlign: align === 'l' ? 'left' : align === 'r' ? 'right' : 'center' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick?.(); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <span>{text}</span>
    </div>
  );
}

/** FL's scrub bar (NewTimeSlider): the play range in orange, the handle at the video's time; clicking or dragging moves the video. */
function Scrub({ x, y, w, h, t, dur, lo, hi, onSeek, onDragging }: {
  x: number; y: number; w: number; h: number; t: number; dur: number; lo: number; hi: number;
  onSeek: (t: number) => void; onDragging: (on: boolean) => void;
}) {
  const pad = 11;
  const len = Math.max(1, w - 2 * pad);
  const px = (v: number) => pad + (dur > 0 ? clamp(v / dur, 0, 1) : 0) * len;
  const drag = useRef(false);
  const seekAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width > 0 ? r.width / w : 1; // the editor is scaled to its window
    onSeek(clamp(((e.clientX - r.left) / k - pad) / len, 0, 1) * dur);
  };
  const end = () => { if (drag.current) { drag.current = false; onDragging(false); } };
  const top = h / 2 - 2;
  const rangeHi = hi > 0 ? hi : dur;
  return (
    <div className={'vp-scrub' + (dur > 0 ? '' : ' off')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (dur <= 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = true;
        onDragging(true);
        seekAt(e);
      }}
      onPointerMove={(e) => { if (drag.current) seekAt(e); else setHint('Video position (use left/right keys for previous/next frame)'); }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onPointerLeave={() => { if (!drag.current) clearHint(); }}>
      <div className="vp-track" style={{ left: pad, width: len, top }} />
      <div className="vp-range" style={{ left: px(lo), width: Math.max(0, px(rangeHi) - px(lo)), top }} />
      <div className="vp-tick" style={{ left: pad, top: h / 2 + 5, height: 9 }} />
      <div className="vp-tick" style={{ left: pad + len, top: h / 2 + 5, height: 9 }} />
      <div className="vp-thumb" style={{ left: px(t) - 11, top: h / 2 - 11 }} />
    </div>
  );
}

/** The volume wheel (FL's VolumeWheel, 0..127): bound to the Volume parameter. */
function VolumeKnob({ x, y }: { x: number; y: number }) {
  const p = useParam('volume', { defaultValue: 100, travel: 220 });
  const h = useControl(p.control, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="vp-btn" style={{ left: x, top: y, width: 26, height: 26 }} {...h}>
      <G.VolumeWheelView size={26} t={p.value / 127} />
    </div>
  );
}

/** The mute button (Mute audio, M): bound to the Mute audio parameter. */
function MuteButton({ x, y }: { x: number; y: number }) {
  const p = useParam('mute');
  const h = useControl(p.control);
  const muted = p.value >= 0.5;
  return (
    <Btn x={x} y={y} w={25} h={25} hint={`Mute audio (M)${muted ? ': muted' : ''}`}
      onClick={() => { p.control.onBegin?.(); p.set(muted ? 0 : 1); p.control.onEnd?.(); }} onContext={(e) => h.onContextMenu(e)}>
      <G.Speaker muted={muted} color={muted ? '#7b858c' : '#c2c6cb'} />
    </Btn>
  );
}

/** The video's time, re-read while it moves (the song plays, the player runs, the user scrubs). */
function useVideoTime(ctl: VideoController): VideoTime {
  const [, setTick] = useState(0);
  useEffect(() => {
    let last = '';
    const check = () => {
      const t = ctl.time();
      const k = `${Math.round(t.t * 30)}${t.playing ? 'p' : ''}${t.on ? 'o' : ''}`;
      if (k !== last) { last = k; setTick((n) => n + 1); }
    };
    check();
    const off1 = ctl.addView(check);
    const off2 = subscribeLive(check);
    return () => { off1(); off2(); };
  }, [ctl]);
  return ctl.time();
}

// ------------------------------------------------------------------ the picture

function VideoCanvas({ ctl, w, h }: { ctl: VideoController; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || w <= 0 || h <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const draw = () => {
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctl.paint(g, w, h);
    };
    draw();
    return ctl.addView(draw);
  }, [ctl, w, h]);
  return <canvas ref={ref} className="vp-canvas" style={{ width: w, height: h }} />;
}

function Note({ y, small, children }: { y: number; small?: boolean; children: ReactNode }) {
  return <div className={'vp-note' + (small ? ' small' : '')} style={{ top: y, fontSize: small ? undefined : 13, lineHeight: '15px' }}>{children}</div>;
}

// ------------------------------------------------------------------ menus

// ------------------------------------------------------------------ the panel

export function PlayerPanel({ ctl, width, height }: { ctl: VideoController; width: number; height: number }) {
  const { slotId, params } = useFxEditor();
  const s = vpState(params);
  const status = useSyncExternalStore(ctl.subscribeStatus, ctl.getStatus);
  const hostPlaying = useLive((l) => l.playing);
  const tm = useVideoTime(ctl);
  const root = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dlg, setDlg] = useState<{ what: 'Start' | 'End' | 'Current'; value: number } | null>(null);
  const playParam = useParam('play');
  const playCtl = useControl(playParam.control);

  const W = width;
  const dur = ctl.duration();
  const { lo, hi } = playRange(s.start, s.end, dur);
  const playing = s.link ? hostPlaying : s.play;
  const showPanel = s.dock || hover || dragging || dlg !== null;
  const picH = s.dock ? Math.max(0, height - PANEL_H) : height;
  const fmt = (t: number) => formatVideoTime(t, s.timeMode, s.fps);
  const startText = fmt(s.start);
  const endText = fmt(hi > 0 ? hi : dur);

  const tx = 125 + Math.round((W - 410) / 2); // the transport (125 at FL's width), centred
  const volX = W - 65, muteX = W - 37, endBtnX = W - 109, endLabelX = W - 86;

  const toggle = (key: 'loop' | 'link', label: string) => A.editFx(slotId, label, (p) => { p[key] = !s[key]; });
  const openOptions = (x: number, y: number) => openMenu(x, y, optionsMenu(ctl, s));
  const key = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (k === 'p') { if (e.shiftKey) ctl.stop(); else ctl.togglePlay(); }
    else if (k === 'l') toggle('loop', 'Loop');
    else if (k === 'h') toggle('link', 'Link transport');
    else if (k === 'm') { const v = s.mute ? 0 : 1; A.setFxParam(slotId, 'mute', v); }
    else if (k === 's') ctl.setStartHere();
    else if (k === 'e') ctl.setEndHere();
    else if (e.key === 'ArrowLeft') ctl.nudge(-1);
    else if (e.key === 'ArrowRight') ctl.nudge(1);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const dialog = dlg && (
    <SetTimeDialog
      title={timeDialogTitle(dlg.what, s.timeMode)} mode={s.timeMode} clipFps={s.fps} value={dlg.value}
      onCancel={() => setDlg(null)}
      onAccept={(t) => {
        const d = dlg.what;
        setDlg(null);
        if (d === 'Start') ctl.setStart(t);
        else if (d === 'End') ctl.setEnd(t);
        else ctl.seek(t);
      }} />
  );

  return (
    <div ref={root} className="vp-root" tabIndex={0} style={{ width, height }}
      onKeyDown={key}
      onPointerDownCapture={() => root.current?.focus({ preventScroll: true })}
      onPointerEnter={() => setHover(true)} onPointerMove={() => { if (!hover) setHover(true); }} onPointerLeave={() => setHover(false)}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={(e) => {
        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        e.preventDefault();
        e.stopPropagation();
        void loadVideoFile(slotId, f);
      }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openOptions(e.clientX, e.clientY); }}>
      <VideoCanvas ctl={ctl} w={width} h={picH} />
      {status === 'none' && <Note y={57}>No video</Note>}
      {status === 'loading' && <Note y={57}>Loading...</Note>}
      {status === 'missing' && <><Note y={57}>No video</Note><Note y={80} small>{`"${s.file}" is not in this browser's storage: load it again with the folder button`}</Note></>}
      {status === 'error' && <Note y={57}>{`There was an error loading the file: "${s.file}".`}</Note>}
      {status === 'ready' && s.videoKey !== '' && s.sampleId === '' && (
        <Note y={6} small>{s.duration > MAX_AUDIO_SECONDS ? 'No sound: the audio is too long to decode here (over 10 minutes)' : 'No sound: no audio track could be decoded from this file'}</Note>
      )}

      {showPanel && (
        <div className={'vp-panel' + (s.dock ? '' : ' float')} style={{ top: height - PANEL_H }}>
          <Btn x={12} y={4} w={32} h={34} cls="vp-round" hint="Load video file..." onClick={() => pickVideoFile(slotId)}>
            <G.Folder size={16} color="#cfd8de" />
          </Btn>
          <Btn x={50} y={8} w={21} h={24} cls="vp-ghost" hint="Plugin options"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openOptions(r.left, r.bottom + 1); }}>
            <G.OptionsArrow color="#e8eef3" />
          </Btn>

          <TimeLabel x={13} y={50} w={72} align="l" text={startText} hint="Start time (click to go to, right click to set)"
            onClick={() => ctl.seek(Math.max(0, s.start))} onContext={() => setDlg({ what: 'Start', value: Math.max(0, s.start) })} />
          <Btn x={88} y={50} w={20} h={16} cls="vp-small" hint="Set current position as start time (S)" onClick={() => ctl.setStartHere()}
            onContext={(e) => openMenu(e.clientX, e.clientY, [{ label: `Delay playback by ${fmt(Math.max(0, ctl.songSeconds()))}`, onClick: () => ctl.delayHere() }])}>
            <G.SetArrow dir="start" />
          </Btn>
          <Btn x={endBtnX} y={49} w={20} h={16} cls="vp-small" hint="Set current position as end time (E)" onClick={() => ctl.setEndHere()}>
            <G.SetArrow dir="end" />
          </Btn>
          <TimeLabel x={endLabelX} y={50} w={72} align="r" text={endText} hint="End time (click to go to, right click to set)"
            onClick={() => ctl.seek(hi > 0 ? hi : dur)} onContext={() => setDlg({ what: 'End', value: hi > 0 ? hi : dur })} />

          {/* transport: link, then the loop / play / stop pill, the current time below it */}
          <Btn x={tx} y={9} w={25} h={25} cls="vp-ghost" hint="Slave playback to host (H)" onClick={() => toggle('link', 'Link transport')}
            style={{ opacity: 1 }}>
            <G.Chain size={20} color={s.link ? '#bbff55' : '#68737b'} />
          </Btn>
          <div className="vp-pill" style={{ left: tx + 26, top: 4, width: 99, height: 34 }}>
            <Seg x={0} w={33} on={s.loop} hint="Loop (L)" onClick={() => toggle('loop', 'Loop')}><G.Infinity_ size={18} /></Seg>
            <Seg x={33} w={33} on={false} hint="Play / pause (P)" onClick={() => ctl.togglePlay()} onContext={(e) => playCtl.onContextMenu(e)}>
              {playing ? <G.Pause size={18} /> : <G.Play size={18} />}
            </Seg>
            <Seg x={66} w={33} on={false} hint="Stop (Shift+P)" onClick={() => ctl.stop()}><G.Stop size={18} /></Seg>
          </div>
          <TimeLabel x={tx + 38} y={50} w={72} align="c" text={fmt(tm.t)} hint="Current time (right click to set)"
            onContext={() => setDlg({ what: 'Current', value: tm.t })} />

          <VolumeKnob x={volX} y={8} />
          <MuteButton x={muteX} y={8} />
          <Scrub x={4} y={70} w={W - 8} h={30} t={tm.t} dur={dur} lo={lo} hi={hi} onSeek={(t) => ctl.seek(t)} onDragging={setDragging} />
        </div>
      )}
      {dialog}
    </div>
  );
}

/** One third of the loop / play / stop pill. */
function Seg({ x, w, on, hint, onClick, onContext, children }: {
  x: number; w: number; on: boolean; hint: string; onClick: () => void; onContext?: (e: React.MouseEvent) => void; children: ReactNode;
}) {
  return (
    <div className={'vp-seg' + (on ? ' on' : '')} style={{ left: x, width: w }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext?.(e); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}
