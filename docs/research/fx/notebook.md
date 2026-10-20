# NoteBook (FL: Fruity NoteBook)

100-page rich-text notepad. Category Visual. Editor 297 x 211. Audio passes through.

## FL facts (form, flfxhost)
- Parameter 0 "Page index" 1..100, default 1; FL's value text is empty.
- Form: TQuickRichEdit (4,4,289,187), Arial 12 px; TNumBar page selector
  (0,192,274,19, `<` number `>`); pencil button (275,192,21,19) "Enable editing".
  Background `#ccd1d5`.
- EnableBtnClick switches the editor between read-only and editable: notes are
  read-only until the pencil is down (not saved).
- State: version 1000, page, pages (RTF). The built-in and "Default" preset page is
  DefaultText.rtf: centred Arial in `#333333`, the title at 13 pt, text at 9 pt:
  "Fruity NoteBook / 100 pages for your project notes. / The page selector is
  automated, have fun!". Factory presets: Default, Empty.

## Implementation
- Pages are stored as sanitised HTML (`pages: { "<n>": html }`, empty pages
  omitted); rich text pasted from other apps keeps its formatting, pictures are
  dropped (FL: "but not pictures"). The default page reproduces the RTF layout
  (title "NoteBook", without the Fruity prefix like all plugin names here).
- The page bar is the automatable parameter (drag, wheel, arrows, right-click
  automation menu); typing merges into one undo step per page.

## Approximations
- RTF itself is not read or written (browsers expose rich text as HTML).
- The page number font stands in for FL's.
