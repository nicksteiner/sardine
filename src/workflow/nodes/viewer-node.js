/**
 * Viewer Node — Terminal sink node that drives the SARViewer component.
 *
 * Receives image_data + render_params and passes them to the main app
 * via an output callback. The SARViewer itself remains a React component
 * managed by main.jsx — this node just configures what it displays.
 *
 * litegraph.js custom node registered as "sardine/Viewer".
 */
import { PORT_TYPES, PORT_COLORS } from '../engine.js';

const CATEGORY = 'sardine/output';

export function registerViewerNode(LiteGraph) {

  function ViewerNode() {
    // Inputs
    this.addInput('image_data', PORT_TYPES.IMAGE_DATA);
    this.addInput('render_params', PORT_TYPES.RENDER_PARAMS);

    // Widgets
    this.addWidget('toggle', 'show_grid', true);
    this.addWidget('toggle', 'pixel_explorer', false);

    // This is a sink node (terminal)
    this.isSink = true;

    // Callback set by WorkflowCanvas to push data to the React app
    this._onViewerUpdate = null;

    this._imageData = null;
    this._renderParams = null;
    this._status = 'idle';

    this.title = 'SAR Viewer';
    this.size = [240, 130];
    this.color = '#1a2d50';
    this.bgcolor = '#0f1f38';
  }

  ViewerNode.title = 'SAR Viewer';
  ViewerNode.desc = 'Display SAR data in the viewer panel';

  ViewerNode.prototype.onAdded = function () {
    if (this.inputs) {
      for (const inp of this.inputs) {
        inp.color_on = PORT_COLORS[inp.type] || '#4ec9d4';
        inp.color_off = PORT_COLORS[inp.type] || '#4ec9d4';
      }
    }
  };

  ViewerNode.prototype.onExecute = async function (inputs) {
    const imageData = inputs?.image_data || this.getInputData(0);
    const renderParams = inputs?.render_params || this.getInputData(1);

    this._imageData = imageData;
    this._renderParams = renderParams;

    if (imageData) {
      this._status = 'active';

      // Push to React app
      if (this._onViewerUpdate) {
        this._onViewerUpdate({
          imageData,
          renderParams: renderParams || {},
          showGrid: this.widgets[0].value,
          pixelExplorer: this.widgets[1].value,
        });
      }
    } else {
      this._status = 'waiting';
    }

    this.setDirtyCanvas(true);
    return null; // Sink node, no outputs
  };

  ViewerNode.prototype.onDrawForeground = function (ctx) {
    const statusColors = {
      idle: '#5a7099',
      waiting: '#e8833a',
      active: '#3ddc84',
    };

    // Status dot
    ctx.fillStyle = statusColors[this._status] || '#5a7099';
    ctx.beginPath();
    ctx.arc(this.size[0] - 15, 15, 5, 0, Math.PI * 2);
    ctx.fill();

    // Preview info
    ctx.fillStyle = '#8fa4c4';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'left';

    const y = this.size[1] - 12;
    if (this._imageData) {
      ctx.fillStyle = '#3ddc84';
      ctx.fillText(`${this._imageData.width}x${this._imageData.height}`, 8, y);

      if (this._renderParams) {
        ctx.fillStyle = '#d45cff';
        ctx.fillText(this._renderParams.colormap || '', 120, y);
      }
    } else {
      ctx.fillStyle = '#5a7099';
      ctx.fillText('No data connected', 8, y);
    }

    // Draw a mini viewer icon
    ctx.strokeStyle = '#4ec9d4';
    ctx.lineWidth = 1;
    ctx.strokeRect(8, 35, 50, 35);
    ctx.fillStyle = 'rgba(78, 201, 212, 0.1)';
    ctx.fillRect(8, 35, 50, 35);
    // Cross-hair
    ctx.beginPath();
    ctx.moveTo(33, 35);
    ctx.lineTo(33, 70);
    ctx.moveTo(8, 52);
    ctx.lineTo(58, 52);
    ctx.stroke();
  };

  LiteGraph.registerNodeType('sardine/Viewer', ViewerNode);
  ViewerNode.category = CATEGORY;
}

/**
 * Export Node — Export GeoTIFF or PNG figure from the pipeline.
 */
export function registerExportNode(LiteGraph) {

  function ExportNode() {
    this.addInput('image_data', PORT_TYPES.IMAGE_DATA);
    this.addInput('render_params', PORT_TYPES.RENDER_PARAMS);

    this.addWidget('combo', 'format', 'geotiff', { values: ['geotiff', 'png'] });
    this.addWidget('combo', 'mode', 'rendered', { values: ['raw', 'rendered'] });
    this.addWidget('number', 'multilook', 4, { min: 1, max: 32, step: 1 });
    this.addWidget('button', 'Export', '', () => this._export());

    this.isSink = true;
    this._status = 'idle';

    this.title = 'Export';
    this.size = [240, 160];
    this.color = '#1a2d50';
    this.bgcolor = '#0f1f38';
  }

  ExportNode.title = 'Export';
  ExportNode.desc = 'Export data as GeoTIFF or PNG figure';

  ExportNode.prototype._export = async function () {
    const imageData = this.getInputData(0);
    if (!imageData) return;

    this._status = 'exporting';
    this.setDirtyCanvas(true);

    try {
      const { writeRGBAGeoTIFF, downloadBuffer } = await import('../../utils/geotiff-writer.js');

      if (this.widgets[0].value === 'geotiff' && imageData.getExportStripe) {
        const ml = this.widgets[2].value;
        const exportW = Math.ceil(imageData.width / ml);
        const exportH = Math.ceil(imageData.height / ml);

        // Fetch full export stripe
        const stripe = await imageData.getExportStripe({
          startRow: 0,
          numRows: exportH,
          ml,
        });

        const buffer = writeRGBAGeoTIFF(stripe, exportW, exportH, imageData.bounds, imageData.crs);
        downloadBuffer(buffer, 'sardine-export.tif');
      }

      this._status = 'done';
    } catch (e) {
      this._status = 'error';
      console.error('[Export]', e);
    }
    this.setDirtyCanvas(true);
  };

  ExportNode.prototype.onExecute = async function () {
    return null; // Sink node
  };

  ExportNode.prototype.onDrawForeground = function (ctx) {
    const statusColors = {
      idle: '#5a7099',
      exporting: '#4ec9d4',
      done: '#3ddc84',
      error: '#ff6b6b',
    };
    ctx.fillStyle = statusColors[this._status] || '#5a7099';
    ctx.beginPath();
    ctx.arc(this.size[0] - 15, 15, 5, 0, Math.PI * 2);
    ctx.fill();
  };

  LiteGraph.registerNodeType('sardine/Export', ExportNode);
  ExportNode.category = CATEGORY;
}
