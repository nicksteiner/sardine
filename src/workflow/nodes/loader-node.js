/**
 * NISAR Loader Node — Load NISAR GCOV HDF5 from URL via h5chunk streaming.
 *
 * Wraps listNISARDatasetsFromUrl + loadNISARGCOVFromUrl / loadNISARRGBComposite.
 * Accepts file_info from Discovery node, outputs image_data for Viewer.
 *
 * litegraph.js custom node registered as "sardine/NISARLoader".
 */
import { PORT_TYPES, PORT_COLORS } from '../engine.js';
import {
  listNISARDatasetsFromUrl,
  loadNISARGCOVFromUrl,
  loadNISARRGBComposite,
} from '../../loaders/nisar-loader.js';
import {
  autoSelectComposite,
  getAvailableComposites,
  getRequiredDatasets,
  getRequiredComplexDatasets,
} from '../../utils/sar-composites.js';

const CATEGORY = 'sardine/loaders';

export function registerLoaderNode(LiteGraph) {

  function NISARLoaderNode() {
    // Inputs
    this.addInput('file_info', PORT_TYPES.FILE_INFO);

    // Outputs
    this.addOutput('image_data', PORT_TYPES.IMAGE_DATA);
    this.addOutput('datasets', PORT_TYPES.DATASET_LIST);

    // Widgets
    this.addWidget('combo', 'frequency', 'A', { values: ['A', 'B'] });
    this.addWidget('combo', 'polarization', 'HHHH', {
      values: ['HHHH', 'HVHV', 'VVVV', 'VHVH'],
    });
    this.addWidget('combo', 'mode', 'single', { values: ['single', 'rgb'] });
    this.addWidget('combo', 'composite', 'dual-pol-h', {
      values: ['dual-pol-h', 'dual-pol-v', 'pauli', 'quad-pol'],
    });
    this.addWidget('button', 'Load', '', () => this._load());

    // Internal state
    this._datasets = [];
    this._imageData = null;
    this._streamReader = null;
    this._status = 'idle'; // idle | scanning | loading | ready | error
    this._error = null;
    this._lastUrl = null;
    this._loadingProgress = '';

    this.title = 'NISAR Loader';
    this.size = [300, 230];
    this.color = '#1a2d50';
    this.bgcolor = '#0f1f38';
  }

  NISARLoaderNode.title = 'NISAR Loader';
  NISARLoaderNode.desc = 'Load NISAR GCOV HDF5 product from URL';

  NISARLoaderNode.prototype.onAdded = function () {
    // Color-code the output slots
    if (this.outputs) {
      for (const out of this.outputs) {
        out.color_on = PORT_COLORS[out.type] || '#4ec9d4';
        out.color_off = PORT_COLORS[out.type] || '#4ec9d4';
      }
    }
    if (this.inputs) {
      for (const inp of this.inputs) {
        inp.color_on = PORT_COLORS[inp.type] || '#e8833a';
        inp.color_off = PORT_COLORS[inp.type] || '#e8833a';
      }
    }
  };

  /**
   * When file_info arrives from upstream, auto-scan for available datasets.
   */
  NISARLoaderNode.prototype.onConnectionsChange = function () {
    const fileInfo = this.getInputData(0);
    if (fileInfo && fileInfo.url && fileInfo.url !== this._lastUrl) {
      this._lastUrl = fileInfo.url;
      this._scanDatasets(fileInfo.url);
    }
  };

  NISARLoaderNode.prototype._scanDatasets = async function (url) {
    this._status = 'scanning';
    this._error = null;
    this.setDirtyCanvas(true);

    try {
      const result = await listNISARDatasetsFromUrl(url);
      this._datasets = result.datasets || result;
      this._streamReader = result._streamReader || null;

      // Update polarization widget with available options
      if (this._datasets.length > 0) {
        const pols = [...new Set(this._datasets.map(d => d.polarization))];
        const freqs = [...new Set(this._datasets.map(d => d.frequency))];
        this.widgets[0].options.values = freqs.length > 0 ? freqs : ['A', 'B'];
        this.widgets[1].options.values = pols.length > 0 ? pols : ['HHHH'];
        this.widgets[0].value = freqs[0] || 'A';
        this.widgets[1].value = pols[0] || 'HHHH';

        // Update composite options
        const composites = getAvailableComposites(this._datasets);
        if (composites.length > 0) {
          this.widgets[3].options.values = composites.map(c => c.id);
          this.widgets[3].value = autoSelectComposite(this._datasets);
        }
      }

      this._status = 'scanned';
    } catch (e) {
      this._status = 'error';
      this._error = e.message;
    }
    this.setDirtyCanvas(true);
  };

  NISARLoaderNode.prototype._load = async function () {
    const fileInfo = this.getInputData(0);
    if (!fileInfo?.url) {
      this._error = 'No file connected';
      this.setDirtyCanvas(true);
      return;
    }

    this._status = 'loading';
    this._error = null;
    this.setDirtyCanvas(true);

    const mode = this.widgets[2].value;
    const freq = this.widgets[0].value;
    const pol = this.widgets[1].value;
    const composite = this.widgets[3].value;

    try {
      let data;
      if (mode === 'rgb' && composite) {
        const requiredPols = getRequiredDatasets(composite);
        const requiredComplexPols = getRequiredComplexDatasets(composite);

        data = await loadNISARRGBComposite(fileInfo.url, {
          frequency: freq,
          compositeId: composite,
          requiredPols,
          requiredComplexPols,
          _streamReader: this._streamReader,
        });
        data.getTile = data.getRGBTile;

        if (data.prefetchOverviewChunks) {
          data.prefetchOverviewChunks().catch(() => {});
        }
      } else {
        data = await loadNISARGCOVFromUrl(fileInfo.url, {
          frequency: freq,
          polarization: pol,
          _streamReader: this._streamReader,
        });

        if (data.mode === 'streaming' && data.prefetchOverviewChunks) {
          data.prefetchOverviewChunks().catch(() => {});
        }
      }

      this._imageData = data;
      this._status = 'ready';
      this.setOutputData(0, data);
      this.setOutputData(1, this._datasets);
      this.triggerSlot(0, data);
    } catch (e) {
      this._status = 'error';
      this._error = e.message;
    }
    this.setDirtyCanvas(true);
  };

  NISARLoaderNode.prototype.onExecute = async function (inputs) {
    // If we have a connected file_info and haven't scanned yet, do so
    const fileInfo = inputs?.file_info || this.getInputData(0);
    if (fileInfo?.url && fileInfo.url !== this._lastUrl) {
      this._lastUrl = fileInfo.url;
      await this._scanDatasets(fileInfo.url);
    }

    if (this._imageData) {
      return [this._imageData, this._datasets];
    }
    return [null, this._datasets || []];
  };

  NISARLoaderNode.prototype.onDrawForeground = function (ctx) {
    const statusColors = {
      idle: '#5a7099',
      scanning: '#e8833a',
      scanned: '#3ddc84',
      loading: '#4ec9d4',
      ready: '#3ddc84',
      error: '#ff6b6b',
    };

    // Status dot
    ctx.fillStyle = statusColors[this._status] || '#5a7099';
    ctx.beginPath();
    ctx.arc(this.size[0] - 15, 15, 5, 0, Math.PI * 2);
    ctx.fill();

    // Status text
    ctx.fillStyle = '#8fa4c4';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    const y = this.size[1] - 12;

    if (this._error) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText(this._error.substring(0, 38), 8, y);
    } else if (this._status === 'scanned') {
      ctx.fillText(`${this._datasets.length} datasets found`, 8, y);
    } else if (this._status === 'loading') {
      ctx.fillStyle = '#4ec9d4';
      ctx.fillText('Loading...', 8, y);
    } else if (this._status === 'ready' && this._imageData) {
      ctx.fillStyle = '#3ddc84';
      ctx.fillText(`${this._imageData.width}x${this._imageData.height}`, 8, y);
    } else if (this._status === 'scanning') {
      ctx.fillStyle = '#e8833a';
      ctx.fillText('Scanning metadata...', 8, y);
    }
  };

  LiteGraph.registerNodeType('sardine/NISARLoader', NISARLoaderNode);
  NISARLoaderNode.category = CATEGORY;
}

/**
 * COG Loader Node — Load Cloud Optimized GeoTIFF from URL.
 */
export function registerCOGLoaderNode(LiteGraph) {

  function COGLoaderNode() {
    this.addInput('url', PORT_TYPES.STRING);
    this.addOutput('image_data', PORT_TYPES.IMAGE_DATA);

    this.addWidget('text', 'url', '');
    this.addWidget('button', 'Load', '', () => this._load());

    this._imageData = null;
    this._status = 'idle';
    this._error = null;

    this.title = 'COG Loader';
    this.size = [280, 120];
    this.color = '#1a2d50';
    this.bgcolor = '#0f1f38';
  }

  COGLoaderNode.title = 'COG Loader';
  COGLoaderNode.desc = 'Load Cloud Optimized GeoTIFF from URL';

  COGLoaderNode.prototype._load = async function () {
    const url = this.getInputData(0) || this.widgets[0].value;
    if (!url) return;

    this._status = 'loading';
    this._error = null;
    this.setDirtyCanvas(true);

    try {
      // Dynamic import to avoid loading geotiff.js when not needed
      const { loadCOG } = await import('../../loaders/cog-loader.js');
      const data = await loadCOG(url);
      this._imageData = data;
      this._status = 'ready';
      this.setOutputData(0, data);
      this.triggerSlot(0, data);
    } catch (e) {
      this._status = 'error';
      this._error = e.message;
    }
    this.setDirtyCanvas(true);
  };

  COGLoaderNode.prototype.onExecute = async function (inputs) {
    if (this._imageData) {
      return [this._imageData];
    }
    return [null];
  };

  COGLoaderNode.prototype.onDrawForeground = function (ctx) {
    const statusColors = {
      idle: '#5a7099',
      loading: '#4ec9d4',
      ready: '#3ddc84',
      error: '#ff6b6b',
    };
    ctx.fillStyle = statusColors[this._status] || '#5a7099';
    ctx.beginPath();
    ctx.arc(this.size[0] - 15, 15, 5, 0, Math.PI * 2);
    ctx.fill();

    if (this._error) {
      ctx.fillStyle = '#ff6b6b';
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.fillText(this._error.substring(0, 35), 8, this.size[1] - 12);
    } else if (this._imageData) {
      ctx.fillStyle = '#3ddc84';
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.fillText(`${this._imageData.width}x${this._imageData.height}`, 8, this.size[1] - 12);
    }
  };

  LiteGraph.registerNodeType('sardine/COGLoader', COGLoaderNode);
  COGLoaderNode.category = CATEGORY;
}
