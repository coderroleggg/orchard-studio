# ZGameEditor Visualizer (FL: ZGameEditor Visualizer), reduced

Layered, audio-reactive video effect. Category Visual. Audio passes through
unchanged. FL hosts ZGameEditor projects (hundreds of OpenGL shader effects in
`Plugins/Fruity/Effects/ZGameEditor Visualizer/Effects`) in up to 100 layers and
renders them into a video window. This version keeps FL's window, layer model,
parameter indexing and right-hand panel, with 17 Canvas 2D effects named after
FL's, 8 layers at most.

## Sources
- flfxhost: parameter names and indices (0 Camera zoom, 1 Camera angle, then per
  layer n: 16 + 48n "Layer A - Effect select", 20 + 48n "Layer A - Enabled",
  32 + 48n + k "Layer A - Parameter k", all 0..65535, value texts empty except
  "(none)"). The plugin itself needs OpenGL, so flfxhost can't load its presets.
- `Data/Patches/Plugin presets/Effects/ZGameEditor Visualizer/Default.fst` (read
  as text, not copied): `GlWindowMode=1` (Detached), `LayerCount=1`, `FPS=1`,
  `AspectRatio=16:9`, `[Detached] Left=1005 Top=207 Width=689 Height=577`. These
  are our defaults.
- The plugin binary's forms (TPF0 streams, parsed with the DFM tool): MainForm
  (sheets Main / Add content / Settings / Debug log, right panel controls,
  FPS list 15/30/60/75/90/120/144, aspect list 4:3/16:9/4:5/9:16/1:1, window
  modes, workspace menu), AppSetFrame (the 191 px layer column: enable switch,
  previous / next effect, color selector, drag handle, layer menu, effect
  selector, author line, AUDIO SRC / IMAGE SRC / MESH combos at 59 px, TO BUFFER
  + render quality 100%..1024px, parameter panel at 186), ParameterFrame (label
  3..81 right-aligned, slider 86..175 with orange fill `$30A8FF`, chrome knob,
  check box, list combo), hint texts ("Previous effect", "Layer menu", "Add new
  layer", "Hold visualization", "Redirect this layer to a buffer...").
- FL manual page (layer icons, layer menu, workspace menu, keyboard shortcuts,
  To buffer semantics, window modes). The screenshot gives the runtime layout:
  the icons sit in the 23 px header, so the frame's design offsets are shifted
  up by 20 px.

## Implemented
- Editor 736 x 584: slanted sheet tabs; Main sheet with horizontally scrolling
  layer columns (collapsed columns 24 px, click to expand) and the "+" tab;
  layer header (enable, name or letter, previous / next effect, color selector
  via the browser colour picker, drag handle to move the layer, layer menu:
  Insert, Clone, Move left / right, Delete, Rename, Collapse, Solo, Copy, Paste,
  Save / Load layer to a JSON file); effect selector with category submenus;
  parameter rows (sliders, LED check boxes, list combos; right-click gives the
  automation menu of "Layer A - Parameter k"); TO BUFFER with quality; IMAGE SRC
  lists the buffers of TO BUFFER layers on the left.
- Right panel at FL's positions: Wizard and Export Video (disabled), Hold
  visualization (snowflake), Window mode, Frame rate Max / Current (measured),
  Aspect ratio, Rotate wheel (Camera angle) and Zoom slider (Camera zoom).
- Workspace menu (right-click): Collapse / Expand all, Auto-collapse layers,
  Save still image (PNG download), Show background pattern in preview.
- Keyboard (Main sheet focused): Left / Right select, Shift+Left / Right move,
  C collapse, Ctrl/Cmd+C / V copy / paste, S solo, Del or D delete, Ins or I
  insert, X (Export Video, unavailable).
- Add content: Text sheet edits the lines used by TextDraw (macro [title] = the
  project title; [author] / [comment] are empty here). Images, HTML, Meshes and
  Video cue points show FL's layout with disabled controls.
- Settings: Antialias (off = half-resolution, pixelated output), About, Reset
  to defaults; the rest disabled. Debug log: "Enable debug log" shows renderer
  messages (effects loaded, output size, effect errors).
- Video window: Detached and Wallpaper are the module's `Persistent` part, so
  they live as long as the slot, editor open or not: Detached is an app Window
  (`fxaux:<slotId>`, fullscreen button, options menu, close = hide) opened when
  the plugin is inserted, like FL, with its rect saved in the plugin state
  ([Detached] Left/Top/Width/Height); Wallpaper fills the workspace behind the
  windows. Attached belongs to the plugin window, as in FL: it's docked above
  the editor window (below it when there's no room) while the editor is open. Letterboxed to the
  aspect ratio, frame-rate cap, Hold freezes the picture, fullscreen
  (double-click; any key restores), right-click menu.
- Rendering: layers A..last composited into a transparent frame (black behind);
  a TO BUFFER layer copies the frame into its buffer (at the chosen quality) and
  clears it; Postprocess / Feedback effects with an IMAGE SRC buffer process the
  buffer and draw the result over the frame, otherwise they process the frame;
  camera zoom 2^(2v) and angle v * 360 deg transform the final image. Effects
  take Alpha as transparency and Hue / Saturation / Lightness as HSL like FL's.
- DSP: 2048-point Hann FFT every 1024 samples, 64 log bands 30 Hz..16 kHz over
  66 dB (max since the last poll), 512-sample stereo waveform, peak and RMS;
  analysis runs only while a video output polls it. The video smooths it (fast
  attack, slow release) and derives bass / mid / high.

## Effects (own drawings; FL's parameter names and order)
Background: SolidColor, Grid, ItsFullOfStars. Peak Effects: Linear, Polar,
WaveSimple, VectorScope, Reactive Sphere. Particles: ColorBlobs. Canvas effects:
FreqRing. Tunnel: Oldschool Tube. Feedback: WarpBack (true frame feedback).
Text: TextDraw. Postprocess: Blur, RGB Shift, ScanLines, Vignette.

## Not implemented (documented omissions)
- FL's shader effects and their exact looks, more than 8 layers, blend modes of
  FL's effects, images / videos / webcams / windows / NDI / Spout as image
  sources, meshes, HTML text (TextTrueType), video cue points, MIDI input, DMX,
  stereoscopic modes, internal controllers, the Wizard, video export, the layer
  arrangement editor, effect help and "Edit effect in ZGameEditor".
- FL's factory presets (they need FL's effects); the presets here are our own
  demonstrations, plus FL's Default.
- AUDIO SRC can only be the track hosting the plugin.
