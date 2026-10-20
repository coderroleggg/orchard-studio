// Sytrus editor colours and captions. Colours come from FL's editor form
// (Delphi TColor values) and FL's Sytrus thumbnail; captions are FL's strings
// (Sytrus_x64 resource strings). Original drawing, no FL artwork.

export const C = {
  /** SynthPanel (3880753). */
  panel: '#31373b',
  /** Page panels (MainPanel / OpPanel ... 3683116). */
  page: '#2c3338',
  /** Rounded bevels (2828324). */
  bevel: '#24282b',
  /** FS_Pad sections (MODULATION, EQ, QUALITY), as sampled. */
  pad: '#272b30',
  /** Tab strip / selector background. */
  strip: '#21272b',
  stripSep: '#2f3539',
  /** FL's orange (FillColor 4171773 / 3188991). */
  orange: '#ffa830',
  orangeDim: '#c27f27',
  /** Caption labels (10919573) and titles (11117983). */
  label: '#959ea6',
  title: '#9fa5a9',
  /** Digit wheels' text (13948361). */
  digi: '#c9d6d4',
  digiBg: '#1e2326',
  /** Slider rail (7564390), handle (9932427). */
  rail: '#1d2124',
  handleHi: '#d3d6dc',
  handleLo: '#8b8f97',
  /** Knob body (GearColor / CapColor). */
  knobHi: '#4e575d',
  knobLo: '#343b40',
  knobTrack: '#1b1f22',
  /** LED check boxes. */
  ledOn: '#f0845e',
  ledOnHi: '#ffc0a2',
  ledOff: '#3a4045',
  /** Envelope editor (TMEnvEditor): background, grid, curve, points. */
  envBg: '#1b2125',
  envGrid: '#252c31',
  envGridMajor: '#30383e',
  envCurve: '#ffa830',
  envFill: 'rgba(255,168,48,0.10)',
  envPoint: '#ffd38a',
  envLfo: 'rgba(210,220,226,0.45)',
  /** Scopes (THQWAVScope): black / blue-grey background, gray centre line, white-blue trace. */
  scopeBg: '#000000',
  bigScopeBg: '#25273d',
  scopeCenter: '#808080',
  scopeLine: '#e3e5f1',
  /** Harmonics panel (1578260). */
  harmBg: '#141518',
  /** Matrix. */
  matBg: '#23292e',
  matHdr: '#21272b',
  matCellOp: '#3b4247',
  matCellFlt: '#2a2f32',
  matCellPan: '#32393e',
  /** Keyboard (TQuickVectorMIDIKb). */
  kbBevel: '#282e31',
  kbWhite: '#cfd3da',
  kbWhiteC: '#babec5',
  kbBlack: '#2f3031',
  kbPressed: '#fe8025',
  kbRuler: '#2b3134',
} as const;

export const FONT = 'var(--font-ui), Arial, sans-serif';

/** Editor size (SynthPanel 845 x 450; 348 without the testing keyboard). */
export const ED_W = 845;
export const ED_H = 450;
export const ED_H_NOKB = 348;

/** Page panels share this area (MainPanel / OpPanel / FilterPanel / FXPanel). */
export const PAGE = { x: 5, y: 31, w: 533 } as const;

export const TABS = ['MAIN', 'OP 1', 'OP 2', 'OP 3', 'OP 4', 'OP 5', 'OP 6', 'FILTER 1', 'FILTER 2', 'FILTER 3', 'FX'];
/** Editor targets per unit kind (EnvTargetSelect). Operators: 6 articulators + OSC (harmonics). */
export const OP_TARGETS = ['PAN', 'VOL', 'MOD', 'PITCH', 'PHASE', 'DAMP', 'OSC'];
/** Filters: 7 articulators, the waveshaper curve (WS) and the waveshaper mix articulator (WMIX). */
export const FLT_TARGETS = ['PAN', 'VOL', 'CUT', 'RES', 'LOW', 'BAND', 'HIGH', 'WS', 'WMIX'];
export const FX_TARGETS = ['PAN', 'VOL'];
/** Articulator parts (EnvSelect) = SyArt.e[0..7]. */
export const PARTS = ['ENV', 'LFO', 'KEY M', 'VEL M', 'MOD X', 'MOD Y', 'RAND', 'UNI'];
export const PART_NAMES = ['Envelope', 'LFO', 'Key mapping', 'Velocity mapping', 'Modulation X mapping', 'Modulation Y mapping', 'Random mapping', 'Unison mapping'];

export const FILTER_TYPES = ['SVF', 'LP', 'HP', 'LP2', 'BP', 'BS', 'HP2', 'AP', 'LS', 'PK', 'HS', 'LP3', 'PHS'];
export const FILTER_TYPE_NAMES = ['Chocolate state variable', 'Lime low pass', 'Lime high pass', 'Vanilla low pass', 'Vanilla band pass',
  'Vanilla band stop', 'Vanilla high pass', 'Vanilla all pass', 'Vanilla low shelf', 'Vanilla peaking', 'Vanilla high shelf',
  'Mango low pass', 'Cherry phaser'];
export const REV_COLORS = ['B+', 'B', 'F', 'W', 'W+'];
export const REV_COLOR_NAMES = ['Brighter', 'Bright', 'Flat', 'Warm', 'Warmer'];
export const EQ_MODES = ['OFF', 'OUT+FX', 'OUT', 'FX'];
export const EQ_TYPES = ['Low shelf', 'Peaking', 'High shelf'];
export const DEL_NUMS = ['D1', 'D2', 'D3', 'R'];

/** Matrix captions and hint names (FL's strings). */
export const MAT_ROWS = ['1', '2', '3', '4', '5', '6', 'F1', 'F2', 'F3'];
export const MAT_COLS = ['1', '2', '3', '4', '5', '6', 'PAN', 'FX', 'OUT'];
export const MAT_UNIT_NAMES = ['operator 1', 'operator 2', 'operator 3', 'operator 4', 'operator 5', 'operator 6', 'filter 1', 'filter 2', 'filter 3'];

export const pct = (v: number, div: number) => `${Math.round((v / div) * 100)}%`;
