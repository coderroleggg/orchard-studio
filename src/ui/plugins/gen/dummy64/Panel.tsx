// The editor of FL 2026's 64-bit dummies (Wasp, Wasp XT, FL Slayer). FL's form is the same
// for all three (.flref/gen/forms: SynthPanel 356 x 201 at 0, 0, colour 3880753 = #31373b): the
// title "Dummy x64" and three centred lines, with no controls. Positions are FL's form
// coordinates; the text uses the kit's labels (FL's own fonts are not used). Original drawing.
// The third line is our own wording: FL's points to its 32-bit version, which doesn't apply here.

import { FxPanel, Label } from '../../kit';

const TITLE = '#e6eaed';
const TEXT = '#cdd3d7';

export function Dummy64Editor() {
  return (
    <FxPanel width={356} height={201} style={{ background: '#31373b' }}>
      <Label x={5} y={45} w={336} h={18} size={14} bold color={TITLE}>Dummy x64</Label>
      <Label x={5} y={70} w={336} h={15} size={11} color={TEXT}>{"This plugin doesn't have a 64 bit version."}</Label>
      <Label x={5} y={90} w={336} h={15} size={11} color={TEXT}>Your settings have been saved.</Label>
      <Label x={5} y={110} w={336} h={15} size={11} color={TEXT}>It makes no sound, as in the 64-bit original.</Label>
    </FxPanel>
  );
}
