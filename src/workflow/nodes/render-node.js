/**
 * Render Config Node — Assemble visualization parameters.
 *
 * Combines colormap, contrast, stretch mode, gamma, dB toggle
 * into a render_params object consumed by the Viewer node.
 *
 * litegraph.js custom node registered as "sardine/RenderConfig".
 */
import { PORT_TYPES, PORT_COLORS } from '../engine.js';
import { COLORMAP_NAMES } from '../../utils/colormap.js';
import { STRETCH_MODES } from '../../utils/stretch.js';

const CATEGORY = 'sardine/render';

export function registerRenderNode(LiteGraph) {

  function RenderConfigNode() {
    // Inputs
    this.addInput('contrast', PORT_TYPES.CONTRAST);

    // Outputs
    this.addOutput('render_params', PORT_TYPES.RENDER_PARAMS);

    // Widgets
    this.addWidget('combo', 'colormap', 'grayscale', {
      values: COLORMAP_NAMES || [
        'grayscale', 'viridis', 'inferno', 'plasma',
        'sardine', 'flood', 'diverging', 'polarimetric', 'phase',
      ],
    });
    this.addWidget('toggle', 'use_decibels', true);
    this.addWidget('combo', 'stretch', 'linear', {
      values: Object.keys(STRETCH_MODES || { linear: 1, sqrt: 1, gamma: 1, sigmoid: 1 }),
    });
    this.addWidget('number', 'gamma', 1.0, { min: 0.1, max: 5.0, step: 0.1 });
    this.addWidget('number', 'contrast_min', -25, { min: -50, max: 50, step: 0.5 });
    this.addWidget('number', 'contrast_max', 0, { min: -50, max: 50, step: 0.5 });

    this.title = 'Render Config';
    this.size = [260, 200];
    this.color = '#1a2d50';
    this.bgcolor = '#0f1f38';
  }

  RenderConfigNode.title = 'Render Config';
  RenderConfigNode.desc = 'Configure visualization parameters (colormap, contrast, stretch)';

  RenderConfigNode.prototype.onAdded = function () {
    if (this.outputs?.[0]) {
      this.outputs[0].color_on = PORT_COLORS[PORT_TYPES.RENDER_PARAMS];
      this.outputs[0].color_off = PORT_COLORS[PORT_TYPES.RENDER_PARAMS];
    }
    if (this.inputs?.[0]) {
      this.inputs[0].color_on = PORT_COLORS[PORT_TYPES.CONTRAST];
      this.inputs[0].color_off = PORT_COLORS[PORT_TYPES.CONTRAST];
    }
  };

  RenderConfigNode.prototype.onExecute = async function (inputs) {
    const contrastInput = inputs?.contrast || this.getInputData(0);

    // Use connected contrast or manual widget values
    let contrastMin = this.widgets[4].value;
    let contrastMax = this.widgets[5].value;
    let contrastLimits;

    if (contrastInput) {
      if (Array.isArray(contrastInput)) {
        [contrastMin, contrastMax] = contrastInput;
        contrastLimits = contrastInput;
      } else if (contrastInput.R) {
        // Per-channel RGB contrast
        contrastLimits = contrastInput;
      }
    }

    if (!contrastLimits) {
      contrastLimits = [contrastMin, contrastMax];
    }

    const renderParams = {
      colormap: this.widgets[0].value,
      useDecibels: this.widgets[1].value,
      stretchMode: this.widgets[2].value,
      gamma: this.widgets[3].value,
      contrastMin,
      contrastMax,
      contrastLimits,
    };

    this.setOutputData(0, renderParams);
    return [renderParams];
  };

  RenderConfigNode.prototype.onDrawForeground = function (ctx) {
    // Draw a small colormap preview bar at the bottom
    const barY = this.size[1] - 8;
    const barH = 4;
    const barW = this.size[0] - 16;

    // Simple gradient approximation based on colormap name
    const colormapColors = {
      grayscale: ['#000000', '#ffffff'],
      viridis: ['#440154', '#31688e', '#35b779', '#fde725'],
      inferno: ['#000004', '#57106e', '#bc3754', '#fcffa4'],
      plasma: ['#0d0887', '#7e03a8', '#cc4778', '#f0f921'],
      sardine: ['#0a1628', '#4ec9d4', '#e8833a'],
      flood: ['#0a1628', '#4ec9d4', '#ff6b6b'],
    };
    const colors = colormapColors[this.widgets[0].value] || colormapColors.grayscale;
    const grad = ctx.createLinearGradient(8, barY, 8 + barW, barY);
    colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
    ctx.fillStyle = grad;
    ctx.fillRect(8, barY, barW, barH);
  };

  LiteGraph.registerNodeType('sardine/RenderConfig', RenderConfigNode);
  RenderConfigNode.category = CATEGORY;
}

/**
 * Statistics Node — Compute histogram and auto-contrast limits.
 */
export function registerStatisticsNode(LiteGraph) {

  function StatisticsNode() {
    this.addInput('image_data', PORT_TYPES.IMAGE_DATA);
    this.addOutput('stats', PORT_TYPES.STATS);
    this.addOutput('contrast', PORT_TYPES.CONTRAST);

    this.addWidget('toggle', 'use_decibels', true);
    this.addWidget('button', 'Compute', '', () => this._compute());

    this._stats = null;
    this._contrast = null;
    this._status = 'idle';

    this.title = 'Statistics';
    this.size = [220, 130];
    this.color = '#1a2d50';
    this.bgcolor = '#0f1f38';
  }

  StatisticsNode.title = 'Statistics';
  StatisticsNode.desc = 'Compute histogram and auto-contrast from image data';

  StatisticsNode.prototype._compute = async function () {
    const imageData = this.getInputData(0);
    if (!imageData?.getTile) return;

    this._status = 'computing';
    this.setDirtyCanvas(true);

    try {
      const { sampleViewportStats } = await import('../../utils/stats.js');
      const useDb = this.widgets[0].value;
      const stats = await sampleViewportStats(
        imageData.getTile,
        imageData.width,
        imageData.height,
        useDb,
      );

      if (stats) {
        this._stats = stats;
        this._contrast = [stats.p2, stats.p98];
        this._status = 'ready';
        this.setOutputData(0, stats);
        this.setOutputData(1, this._contrast);
        this.triggerSlot(0, stats);
        this.triggerSlot(1, this._contrast);
      }
    } catch (e) {
      this._status = 'error';
      console.error('[Statistics] Compute failed:', e);
    }
    this.setDirtyCanvas(true);
  };

  StatisticsNode.prototype.onExecute = async function (inputs) {
    const imageData = inputs?.image_data || this.getInputData(0);

    // Auto-compute on first connection if not already computed
    if (imageData?.getTile && !this._stats) {
      await this._compute();
    }

    return [this._stats, this._contrast];
  };

  StatisticsNode.prototype.onDrawForeground = function (ctx) {
    const statusColors = {
      idle: '#5a7099',
      computing: '#4ec9d4',
      ready: '#3ddc84',
      error: '#ff6b6b',
    };
    ctx.fillStyle = statusColors[this._status] || '#5a7099';
    ctx.beginPath();
    ctx.arc(this.size[0] - 15, 15, 5, 0, Math.PI * 2);
    ctx.fill();

    if (this._stats) {
      ctx.fillStyle = '#8fa4c4';
      ctx.font = '10px JetBrains Mono, monospace';
      const p2 = this._stats.p2?.toFixed(1) ?? '?';
      const p98 = this._stats.p98?.toFixed(1) ?? '?';
      ctx.fillText(`p2: ${p2}  p98: ${p98}`, 8, this.size[1] - 12);
    }
  };

  LiteGraph.registerNodeType('sardine/Statistics', StatisticsNode);
  StatisticsNode.category = CATEGORY;
}
