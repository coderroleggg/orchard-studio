# HTML NoteBook (FL: Fruity HTML NoteBook)

HTML document viewer. Category Visual. Editor 297 x 288. No parameters. Audio passes through.

## FL facts (form, flfxhost)
- View 297 x 260; bottom panel (0,260,297,28) `#292e32` with Open (folder),
  Back, Forward and a URL field (61,266,231,17, blue focus border `#0f61b2`).
- State: version 1 + the document URL only (FL does not save the HTML). Built-in
  default "file:///DefaultHtml.html" (a page next to the plugin showing the
  title image, linked to Info.html). Factory presets: Default, "FL Studio news"
  (http://www.image-line.com/documents/news.php), "Google search"
  (http://www.google.com/).

## Implementation and safety
- Built-in DefaultHtml/Info pages are our own content (FL's page is an image).
- Opening a file (folder button) reads it locally, sanitises it and keeps the
  result in the state (a browser cannot re-read a local path later): a
  documented deviation from FL, which re-reads the file.
- `sanitizeHtml` (pure TS, allow-list): formatting elements and attributes only;
  script/style/iframe/object/embed/form/svg/media/meta/link/base removed (with
  their content where they have one); all `on*` attributes removed; URLs: links
  keep http(s)/mailto/file/relative/fragment targets in `data-href` (never
  natively navigable), images only as inline `data:image/...;base64`; inline
  styles lose url()/expression/position/var/escapes; ids and anchor names are
  prefixed `hnb-` so a document cannot shadow window globals; stray brackets
  escaped; idempotent.
- Links: fragments scroll, built-in and opened documents navigate (session
  history for Back/Forward), anything else shows a notice: nothing is loaded
  from the internet, so the web presets show the notice with their URL.

## Approximations
- Default font of the view: 16 px Times (a web view's default).
