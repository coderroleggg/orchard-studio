// Parametric EQ 2 editor: graph (left), band panel (right), bottom bar.
// Laid out proportionally from a 700 x 350 design so it scales with the
// window (docs/research/peq2.md 5.1).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useProject, useUi } from '../../store';
import { findFx } from '../../store/actions';
import type { PEQ2Params } from '../../model/peq2';
import { analyzerVisible, watchAcquire, watchPrefer, watchRelease } from './peq2Analyzer';
import { viewParams } from './peq2Edit';
import { computeLayout } from './peq2Layout';
import { PEQ2Graph } from './PEQ2Graph';
import { PEQ2Panel } from './PEQ2Panel';
import { PEQ2Bottom } from './PEQ2Bottom';
import './peq2.css';

export function ParametricEQ2({ slotId }: { slotId: string }) {
  const raw = useProject((p) => findFx(p, slotId)?.fx.params ?? null);
  const stored = useMemo(() => (raw ? viewParams(raw) : null), [raw]);
  // while a band is soloed on Shift the store holds the audition filter; show the real settings
  const [audition, setAudition] = useState<PEQ2Params | null>(null);
  const params = audition ?? stored;

  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const lay = useMemo(() => (size.w > 0 && size.h > 0 ? computeLayout(size.w, size.h) : null), [size.w, size.h]);

  // analyzer data: watched while the editor is open and the analyzer is visible
  const watch = !!params && analyzerVisible(params);
  useEffect(() => {
    if (!watch) return;
    watchAcquire(slotId);
    return () => watchRelease(slotId);
  }, [slotId, watch]);
  const focused = useUi((u) => u.focused === 'fx:' + slotId);
  useEffect(() => {
    if (focused && watch) watchPrefer(slotId);
  }, [focused, watch, slotId]);

  return (
    <div ref={ref} className="peq2" style={lay ? { fontSize: `${Math.max(7, 10 * lay.s)}px` } : undefined}>
      {params && lay && (
        <>
          <PEQ2Graph slotId={slotId} params={params} width={lay.graphW} height={lay.topH} s={lay.s} onAudition={setAudition} />
          <PEQ2Panel slotId={slotId} params={params} lay={lay} />
          <PEQ2Bottom slotId={slotId} params={params} lay={lay} />
        </>
      )}
    </div>
  );
}
