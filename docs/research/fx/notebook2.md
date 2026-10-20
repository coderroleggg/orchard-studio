# NoteBook 2 (FL: Fruity NoteBook 2)

100-page plain-text notepad. Category Visual. Editor 297 x 211. Audio passes through.

## FL facts (form, flfxhost)
- Parameter 0 "Page index" 1..100, default 1, value text "1".
- Form: TQuickMemo (0,0,297,192), P_NormalLight; page selector (0,192,274,19);
  pencil (276,192,21,19). Read-only until the pencil is down (EnableBtnClick).
- State: version 1, page, UTF-16 page texts, then the text size (13). The factory
  Default preset page: "\nFruity NoteBook 2\n\n100 pages for your project
  notes.\n\nThe page selector is automated, have fun!"; Empty has no pages.
- Ctrl+wheel resizes the text (saved).

## Implementation
- `pages: { "<n>": text }` (empty pages omitted) and `zoom` (6..48, default 13);
  text in a textarea with the light UI font, line height 1.28 x size (FL's 13 px
  text has 16.7 px lines in the manual screenshot).
- Ctrl+wheel uses a non-passive native listener so the browser does not zoom.

## Approximations
- Font: system UI font weight 300 for FL's P_NormalLight.
