// Video Player editor (FL: Fruity Video Player): the plugin's page in the
// channel settings window is FL's SynthPanel, 410 x 453: the video picture with
// the control panel (panel.tsx). FL's wrapper can also pull the page out as a
// detached window ("Detached"): the Persistent part keeps that window (a
// resizable app window showing the picture at any size) for as long as the
// plugin exists, together with the video controller, the engine monitor and
// the repair of the decoded audio after a project reload. The file itself is
// loaded with the folder button, the plugin menu or by dropping it on the
// picture (load.ts).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FxPanel, useAuxWindow, useFxEditor, useFxMonitor } from '../../kit';
import { Window } from '../../../windows/Window';
import { store, useUi } from '../../../../store';
import * as A from '../../../../store/actions';
import type { FxEditorModule } from '../../registry';
import { VP_RECT, vpState, type VpState } from '../../../../model/gen/plugins/videoplayer';
import { useController, type VideoController } from './controller';
import { PlayerPanel } from './panel';
import { PANEL_H, optionsMenu } from './menus';
import { ensureAudio, pickVideoFile } from './load';

const W = 410;
const H = 453;

function VideoEditor() {
  const { slotId, params } = useFxEditor();
  const ctl = useController(slotId, params);
  return (
    <FxPanel width={W} height={H} style={{ background: '#000' }}>
      <PlayerPanel ctl={ctl} width={W} height={H} />
    </FxPanel>
  );
}

/** The detached window's rectangle, kept inside the workspace (FL's DetachedForm is 563 x 470 at first). */
function detachedRect(s: VpState): { x: number; y: number; w: number; h: number } {
  const ws = document.getElementById('workspace');
  const vw = ws?.clientWidth ?? window.innerWidth, vh = ws?.clientHeight ?? window.innerHeight;
  const r = s.rect.length === 4 ? s.rect : VP_RECT;
  const w = Math.max(400, Math.min(vw, r[2])), h = Math.max(PANEL_H + 100, Math.min(vh, r[3]));
  return { x: Math.max(0, Math.min(vw - w, r[0])), y: Math.max(0, Math.min(vh - h, r[1])), w, h };
}

/** The window's body: the player at the size the window gives it. */
function DetachedBody({ ctl }: { ctl: VideoController }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, background: '#000' }}>
      {size.w > 0 && size.h > 0 && <PlayerPanel ctl={ctl} width={size.w} height={size.h} />}
    </div>
  );
}

/**
 * Alive as long as the channel: the video controller, the engine's monitor
 * data, the audio repair and the detached window (FL keeps the detached
 * window with the plugin's state).
 */
function VideoPersistent() {
  const { slotId, params, trackName } = useFxEditor();
  const s = vpState(params);
  const ctl = useController(slotId, params);
  useFxMonitor(slotId, (d) => ctl.onMonitor(d));
  useEffect(() => { void ensureAudio(slotId); }, [slotId, s.sampleId, s.videoKey]);

  const id = `fxaux:${slotId}`;
  const open = useAuxWindow(slotId, 'videoplayer', s.detached, () => ({ title: trackName, ...detachedRect(s) }), () => {
    A.setFxStateNoHistory(slotId, 'Close video window', (p) => { p.detached = false; });
  });
  const win = useUi((u) => u.windows[id]);
  useEffect(() => { if (win && win.title !== trackName) A.updateWindow(id, { title: trackName }); }, [trackName]);

  // FL saves the detached window's rectangle with the plugin
  useEffect(() => {
    if (!win?.open || win.maximized) return;
    const t = setTimeout(() => {
      const r = [win.x, win.y, win.w, win.h].map((v) => Math.round(v));
      const cur = vpState(A.findFx(store.project, slotId)?.fx.params ?? {}).rect;
      if (r.some((v, i) => v !== cur[i])) A.setFxStateNoHistory(slotId, 'Move video window', (p) => { p.rect = r; });
    }, 400);
    return () => clearTimeout(t);
  }, [win?.open, win?.x, win?.y, win?.w, win?.h, win?.maximized]);

  if (!open || !s.detached) return null;
  return (
    <Window id={id} title={trackName} minW={400} minH={PANEL_H + 100}
      menu={() => optionsMenu(ctl, vpState(A.findFx(store.project, slotId)?.fx.params ?? {}))}
      onClose={() => A.setFxStateNoHistory(slotId, 'Close video window', (p) => { p.detached = false; })}>
      <DetachedBody ctl={ctl} />
    </Window>
  );
}

export const editor: FxEditorModule = {
  id: 'videoplayer',
  Editor: VideoEditor,
  Persistent: VideoPersistent,
  menu: (slotId) => {
    const s = vpState(A.findFx(store.project, slotId)?.fx.params ?? {});
    return [
      { label: 'Detached', checked: s.detached, onClick: () => A.setFxStateNoHistory(slotId, 'Detached', (p) => { p.detached = !s.detached; }) },
      { label: 'Load video file...', onClick: () => pickVideoFile(slotId) },
    ];
  },
};
