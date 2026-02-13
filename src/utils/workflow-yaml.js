/**
 * SARdine Workflow YAML — serialize/deserialize processing state
 *
 * Generates a human-readable YAML workflow file from the current app state.
 * The YAML can be saved and replayed from the CLI on a collection of files
 * via `sardine-process`.
 *
 * Browser-side: only serialization (no external deps).
 * CLI-side:     uses js-yaml for parsing.
 */

/**
 * Generate a YAML workflow string from the current application state.
 *
 * @param {Object} state
 * @param {string} state.source       - 'cog' | 'nisar' | 'remote'
 * @param {string} state.file         - File path, URL, or s3:// URI
 * @param {string} [state.frequency]  - NISAR frequency ('A' or 'B')
 * @param {string} [state.polarization] - Polarization code (e.g. 'HHHH')
 * @param {string} [state.displayMode] - 'single' | 'rgb'
 * @param {string} [state.compositeId] - RGB composite preset id
 * @param {boolean} state.useDecibels
 * @param {number}  state.multilook   - Export multilook factor
 * @param {string}  state.colormap
 * @param {string}  state.stretchMode
 * @param {number}  state.gamma
 * @param {number}  state.contrastMin
 * @param {number}  state.contrastMax
 * @param {Object}  [state.rgbContrastLimits] - {R:[min,max], G:[min,max], B:[min,max]}
 * @param {string}  state.exportMode  - 'raw' | 'rendered'
 * @param {number[]} [state.subsetBbox] - [minX, minY, maxX, maxY] in CRS coords
 * @param {string}  [state.crs]       - CRS string (e.g. 'EPSG:32610')
 * @param {string}  [state.outputDir] - Output directory for exports
 * @returns {string} YAML string
 */
export function generateWorkflowYAML(state) {
  const lines = [];
  const ts = new Date().toISOString();

  lines.push(`# SARdine Workflow`);
  lines.push(`# Generated: ${ts}`);
  if (state.file) {
    lines.push(`# Source: ${basename(state.file)}`);
  }
  lines.push('');
  lines.push('sardine:');
  lines.push('  version: 1');
  lines.push('');

  // --- source ---
  lines.push('  source:');
  const sourceType = state.source === 'nisar' || state.source === 'remote'
    ? 'nisar-gcov' : 'cog';
  lines.push(`    type: ${sourceType}`);
  // Use ${input} placeholder for batch mode
  lines.push(`    path: "\${input}"  # replace with path, URL, or glob for batch`);
  if (state.file) {
    lines.push(`    # original: ${state.file}`);
  }
  lines.push('');

  // --- dataset ---
  lines.push('  dataset:');
  if (state.frequency) {
    lines.push(`    frequency: ${state.frequency}`);
  }
  if (state.displayMode === 'rgb' && state.compositeId) {
    lines.push(`    mode: rgb`);
    lines.push(`    composite: ${state.compositeId}`);
  } else {
    lines.push(`    mode: single`);
    if (state.polarization) {
      lines.push(`    polarization: ${state.polarization}`);
    }
  }
  lines.push('');

  // --- subset ---
  lines.push('  subset:');
  if (state.subsetBbox && state.subsetBbox.length === 4) {
    const [minX, minY, maxX, maxY] = state.subsetBbox;
    lines.push(`    bbox: [${minX.toFixed(2)}, ${minY.toFixed(2)}, ${maxX.toFixed(2)}, ${maxY.toFixed(2)}]`);
  } else {
    lines.push(`    bbox: null  # full extent (zoom to area and click "Use Viewport")`);
  }
  if (state.crs) {
    lines.push(`    crs: ${state.crs}`);
  }
  lines.push('');

  // --- processing ---
  lines.push('  processing:');
  lines.push(`    decibels: ${state.useDecibels}`);
  lines.push(`    multilook: ${state.multilook || 4}`);
  lines.push(`    stretch: ${state.stretchMode || 'linear'}`);
  lines.push(`    gamma: ${(state.gamma || 1.0).toFixed(2)}`);
  lines.push(`    colormap: ${state.colormap || 'grayscale'}`);

  // Contrast
  if (state.displayMode === 'rgb' && state.rgbContrastLimits) {
    lines.push('    contrast:');
    for (const ch of ['R', 'G', 'B']) {
      const lim = state.rgbContrastLimits[ch];
      if (lim) {
        lines.push(`      ${ch}: [${formatNum(lim[0])}, ${formatNum(lim[1])}]`);
      }
    }
  } else {
    lines.push(`    contrast: [${state.contrastMin}, ${state.contrastMax}]`);
  }
  lines.push('');

  // --- output ---
  lines.push('  output:');
  lines.push(`    format: geotiff`);
  lines.push(`    mode: ${state.exportMode || 'raw'}`);
  lines.push(`    directory: ${state.outputDir || './output'}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Parse a minimal YAML workflow back into a state object.
 * This is a lightweight parser for the known schema — no external deps.
 * For full YAML parsing (CLI side), use js-yaml.
 *
 * @param {string} yaml
 * @returns {Object} Parsed workflow state
 */
export function parseWorkflowYAML(yaml) {
  const state = {
    source: 'cog',
    file: null,
    frequency: 'A',
    polarization: 'HHHH',
    displayMode: 'single',
    compositeId: null,
    useDecibels: true,
    multilook: 4,
    stretchMode: 'linear',
    gamma: 1.0,
    colormap: 'grayscale',
    contrastMin: -25,
    contrastMax: 0,
    rgbContrastLimits: null,
    exportMode: 'raw',
    subsetBbox: null,
    crs: null,
    outputDir: './output',
  };

  const lines = yaml.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#') || t === '') continue;

    // Key-value extraction
    const kv = t.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const val = raw.replace(/^["']|["']$/g, '').trim();

    switch (key) {
      case 'type':
        state.source = val === 'nisar-gcov' ? 'nisar' : 'cog';
        break;
      case 'path':
        if (!val.includes('${input}')) state.file = val;
        break;
      case 'frequency':
        state.frequency = val;
        break;
      case 'polarization':
        state.polarization = val;
        break;
      case 'mode':
        if (val === 'rgb' || val === 'single') state.displayMode = val;
        else if (val === 'raw' || val === 'rendered') state.exportMode = val;
        break;
      case 'composite':
        state.compositeId = val;
        if (val && val !== 'null') state.displayMode = 'rgb';
        break;
      case 'bbox': {
        const nums = val.match(/[\d.eE+-]+/g);
        if (nums && nums.length === 4) {
          state.subsetBbox = nums.map(Number);
        }
        break;
      }
      case 'crs':
        state.crs = val;
        break;
      case 'decibels':
        state.useDecibels = val === 'true';
        break;
      case 'multilook':
        state.multilook = parseInt(val) || 4;
        break;
      case 'stretch':
        state.stretchMode = val;
        break;
      case 'gamma':
        state.gamma = parseFloat(val) || 1.0;
        break;
      case 'colormap':
        state.colormap = val;
        break;
      case 'contrast': {
        const nums = val.match(/[\d.eE+-]+/g);
        if (nums && nums.length === 2) {
          state.contrastMin = parseFloat(nums[0]);
          state.contrastMax = parseFloat(nums[1]);
        }
        break;
      }
      case 'format':
        // geotiff only for now
        break;
      case 'directory':
        state.outputDir = val;
        break;
      // Per-channel contrast lines (R, G, B)
      case 'R': case 'G': case 'B': {
        const nums = val.match(/[\d.eE+-]+/g);
        if (nums && nums.length === 2) {
          if (!state.rgbContrastLimits) state.rgbContrastLimits = {};
          state.rgbContrastLimits[key] = [parseFloat(nums[0]), parseFloat(nums[1])];
        }
        break;
      }
    }
  }

  return state;
}

/**
 * Generate a download blob from a YAML string.
 * @param {string} yaml
 * @param {string} filename
 */
export function downloadWorkflowYAML(yaml, filename = 'sardine-workflow.yaml') {
  const blob = new Blob([yaml], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- helpers ---

function basename(path) {
  return path.split('/').pop().split('\\').pop();
}

function formatNum(n) {
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) < 0.01 || Math.abs(n) > 1e6) return n.toExponential(2);
  return n.toFixed(4);
}
