// UI state (not part of the undo history or saved project data).

import type { Id } from '../model/types';
import { loadRecSettings } from '../audio/recSettings';
import type { RecSettings } from '../model/recording';

export type ToolId = 'draw' | 'paint' | 'delete' | 'mute' | 'slip' | 'slice' | 'select' | 'zoom' | 'playback';

export type SnapId =
  | 'main' | 'line' | 'cell' | 'none'
  | '1/6step' | '1/4step' | '1/3step' | '1/2step' | 'step'
  | '1/6beat' | '1/4beat' | '1/3beat' | '1/2beat' | 'beat' | 'bar';

export interface WindowState {
  id: string;
  title: string;
  open: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  maximized: boolean;
  minimized: boolean;
}

export interface PianoRollUi {
  channelId: Id | null;
  tool: ToolId;
  snap: SnapId;
  pxPerTick: number;
  keyHeight: number;
  scrollTick: number;
  scrollY: number; // px from the top of the key range
  eventTarget: 'vel' | 'rel' | 'fine' | 'pan' | 'modX' | 'modY';
  eventHeight: number;
  selected: Id[];
  lastLen: number; // last used note length (ticks)
  lastVel: number;
  ghostNotes: boolean;
  slideMode: boolean; // S: new notes are slide notes
  portaMode: boolean; // O: new notes are porta notes
  colorGroup: number; // colour group for new notes
}

export interface PlaylistUi {
  tool: ToolId;
  snap: SnapId;
  pxPerTick: number;
  trackHeight: number;
  scrollTick: number;
  scrollTrack: number;
  selected: Id[];
  lastLen: number | null;
  picker: boolean; // picker panel (Alt+P)
  /** Automation clip used as the clip source (null: the current pattern). */
  autoSource: Id | null;
  /** Audio Clip channel used as the clip source (null: the current pattern or automation clip). */
  audioSource: Id | null;
  /** Audio clips: show the fade and gain handles (Shift+F). */
  showFades: boolean;
  /** Audio clips: dragging an edge stretches the audio instead of trimming it (Shift+M). */
  stretchOnResize: boolean;
  /** Automation editing switches: Step (free-hand points per grid step), Slide (later points follow). */
  autoStep: boolean;
  autoSlide: boolean;
  /** Time selection (ruler Ctrl+drag): loops on playback; new automation clips span it. */
  timeSel: { start: number; end: number } | null;
}

export interface UiState {
  windows: Record<string, WindowState>;
  zTop: number;
  focused: string | null;
  selectedChannels: Id[];
  pianoRoll: PianoRollUi;
  playlist: PlaylistUi;
  mixerSelected: number;
  browserVisible: boolean;
  browserWidth: number;
  mainSnap: SnapId;
  metronome: boolean;
  /** The Record button is on (armed): Play records the armed mixer tracks. */
  recording: boolean;
  /** Recording options and toolbar switches (program settings, kept in local storage). */
  rec: RecSettings;
  timeDisplay: 'bst' | 'msc';
  channelRackShowAll: boolean;
  graphEditor: boolean;
  graphLane: 'key' | 'vel' | 'rel' | 'fine' | 'pan' | 'modX' | 'modY' | 'shift';
  channelRackFilter: string;
  typingKeyboard: boolean;
  autoScroll: boolean;
  monitorMode: 'scope' | 'spectrum' | 'peak';
  interpolation: import('../model/sampler').InterpMode;
}

export function defaultUi(): UiState {
  const w = (id: string, title: string, x: number, y: number, ww: number, h: number, open: boolean, z: number): WindowState => ({
    id, title, open, x, y, w: ww, h, z, maximized: false, minimized: false,
  });
  return {
    windows: {
      playlist: { ...w('playlist', 'Playlist - Arrangement', 0, 0, 1000, 600, true, 1), maximized: true },
      channelRack: w('channelRack', 'Channel rack', 120, 60, 560, 250, true, 3),
      pianoRoll: w('pianoRoll', 'Piano roll', 90, 40, 900, 520, false, 2),
      mixer: w('mixer', 'Mixer', 60, 120, 1040, 470, false, 2),
    },
    zTop: 10,
    focused: 'channelRack',
    selectedChannels: [],
    pianoRoll: {
      channelId: null,
      tool: 'draw',
      snap: 'main',
      pxPerTick: 0.9,
      keyHeight: 14,
      scrollTick: 0,
      scrollY: (131 - 78) * 14,
      eventTarget: 'vel',
      eventHeight: 110,
      selected: [],
      lastLen: 24,
      lastVel: 100,
      ghostNotes: true,
      slideMode: false,
      portaMode: false,
      colorGroup: 0,
    },
    playlist: {
      tool: 'draw',
      snap: 'main',
      pxPerTick: 0.12,
      trackHeight: 56,
      scrollTick: 0,
      scrollTrack: 0,
      selected: [],
      lastLen: null,
      picker: true,
      autoSource: null,
      audioSource: null,
      showFades: true,
      stretchOnResize: false,
      autoStep: false,
      autoSlide: true, // FL: STEP off, SLIDE on
      timeSel: null,
    },
    mixerSelected: 0,
    browserVisible: true,
    browserWidth: 210,
    mainSnap: 'line',
    metronome: false,
    recording: false,
    rec: loadRecSettings(),
    timeDisplay: 'bst',
    channelRackShowAll: true,
    graphEditor: false,
    graphLane: 'vel',
    channelRackFilter: 'All',
    typingKeyboard: false,
    autoScroll: true,
    monitorMode: 'scope',
    interpolation: 'sinc24',
  };
}
