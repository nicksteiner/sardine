/**
 * InundationApp — guided ATBD app for NISAR inundation classification.
 *
 * Thin wrapper around `AtbdAppShell`. Passes Inundation-specific algorithm
 * opts and copy; no algorithm-param sliders (the 6-class classifier has no
 * user-tunable knobs beyond Nave, which the runner defaults to 2).
 *
 * Flow (implemented by the shell):
 *   1. Location     — paste lon,lat.
 *   2. Auto-stack   — CMR → group → rank → pick stack.
 *   3. ROI          — optional; default = stack bbox.
 *   4. Run          — runATBD({ algorithm: 'inundation' }).
 *   5. View/Export  — classification overlay + GeoTIFF.
 */
import React from 'react';
import AtbdAppShell from '../shared/AtbdAppShell.jsx';
import { ALGORITHM_POL_REQUIREMENTS } from '@src/utils/atbd-auto-stack.js';

export default function InundationApp() {
  return (
    <AtbdAppShell
      algorithm="inundation"
      testIdPrefix="inundation"
      title="Inundation ATBD"
      blurb="Pick a location → auto-select a NISAR GCOV stack → classify open-water / flooded-vegetation / flooded-bare."
      compositeId="dual-pol-h"
      polNote={`Required pols: ${ALGORITHM_POL_REQUIREMENTS.inundation.join(' + ')}. Map-click selection is a follow-up (D296).`}
      exportFilenamePrefix="inundation"
    />
  );
}
