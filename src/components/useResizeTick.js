import { useEffect, useState } from 'react';

/**
 * useResizeTick — bumps a counter whenever the element behind `ref` changes
 * size, so a canvas overlay can redraw.
 *
 * The mark overlays (ROI box, measured line, class map, coordinate grid) size
 * their bitmap at draw time from clientWidth/Height and otherwise redraw only
 * when the view state changes.  Collapsing the side panel or opening the
 * bottom drawer resizes the viewer without touching the view state: deck
 * re-centres the imagery, the stale overlay bitmap is stretched to the new
 * box, and the marks visibly leave the image until the next pan.  Include the
 * returned tick in the draw effect's dependencies.
 */
export function useResizeTick(ref) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return tick;
}
