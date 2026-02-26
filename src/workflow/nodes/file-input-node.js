/**
 * File Input Node — Load a local file from the browser via file picker or drag-and-drop.
 *
 * Opens the native browser file dialog. For NISAR HDF5 files, outputs a file_info
 * object that the NISAR Loader node can consume. Also supports direct loading
 * via the local File API (h5chunk streams from File.slice()).
 *
 * litegraph.js custom node registered as "sardine/FileInput".
 */
import { PORT_TYPES, PORT_COLORS } from '../engine.js';
import { isNISARFile, isCOGFile } from '../../utils/bucket-browser.js';
import { listNISARDatasets, loadNISARGCOV, loadNISARRGBComposite } from '../../loaders/nisar-loader.js';
import {
  autoSelectComposite,
  getAvailableComposites,
  getRequiredDatasets,
  getRequiredComplexDatasets,
} from '../../utils/sar-composites.js';

const CATEGORY = 'sardine/sources';

export function registerFileInputNode(LiteGraph) {

  function FileInputNode() {
    // Outputs
    this.addOutput('file_info', PORT_TYPES.FILE_INFO);
    this.addOutput('image_data', PORT_TYPES.IMAGE_DATA);
    this.addOutput('datasets', PORT_TYPES.DATASET_LIST);

    // Widgets
    this.addWidget('button', 'Choose File...', '', () => this._openFilePicker());
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
    this._file = null;       // Browser File object
    this._fileName = null;
    this._fileType = null;   // 'nisar' | 'cog'
    this._datasets = [];
    this._imageData = null;
    this._status = 'idle';   // idle | selected | scanning | scanned | loading | ready | error
    this._error = null;

    this.title = 'File Input';
    this.size = [300, 250];
    this.color = '#1a2d50';
    this.bgcolor = '#0f1f38';
  }

  FileInputNode.title = 'File Input';
  FileInputNode.desc = 'Load a local HDF5 or GeoTIFF file from the browser';

  FileInputNode.prototype.onAdded = function () {
    if (this.outputs) {
      for (const out of this.outputs) {
        out.color_on = PORT_COLORS[out.type] || '#4ec9d4';
        out.color_off = PORT_COLORS[out.type] || '#4ec9d4';
      }
    }
  };

  /**
   * Open the browser file picker dialog.
   */
  FileInputNode.prototype._openFilePicker = function () {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.h5,.hdf5,.he5,.tif,.tiff';
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this._file = file;
      this._fileName = file.name;

      // Detect file type
      if (isNISARFile(file.name)) {
        this._fileType = 'nisar';
      } else if (isCOGFile(file.name)) {
        this._fileType = 'cog';
      } else {
        this._fileType = 'nisar'; // default
      }

      this._status = 'selected';
      this.setDirtyCanvas(true);

      // Auto-scan datasets for NISAR files
      if (this._fileType === 'nisar') {
        this._scanDatasets();
      }
    };
    input.click();
  };

  /**
   * Scan NISAR file for available datasets (frequency/polarization).
   */
  FileInputNode.prototype._scanDatasets = async function () {
    if (!this._file) return;

    this._status = 'scanning';
    this._error = null;
    this.setDirtyCanvas(true);

    try {
      const datasets = await listNISARDatasets(this._file);
      this._datasets = datasets;

      // Update widget options with discovered values
      if (datasets.length > 0) {
        const freqs = [...new Set(datasets.map(d => d.frequency))];
        const pols = [...new Set(datasets.map(d => d.polarization))];
        this.widgets[1].options.values = freqs.length > 0 ? freqs : ['A', 'B'];
        this.widgets[2].options.values = pols.length > 0 ? pols : ['HHHH'];
        this.widgets[1].value = freqs[0] || 'A';
        this.widgets[2].value = pols[0] || 'HHHH';

        // Update composite options
        const composites = getAvailableComposites(datasets);
        if (composites.length > 0) {
          this.widgets[4].options.values = composites.map(c => c.id);
          this.widgets[4].value = autoSelectComposite(datasets);
        }
      }

      this._status = 'scanned';
      this.setOutputData(2, datasets);
    } catch (e) {
      this._status = 'error';
      this._error = e.message;
    }
    this.setDirtyCanvas(true);
  };

  /**
   * Load the selected dataset from the local file.
   */
  FileInputNode.prototype._load = async function () {
    if (!this._file) {
      this._error = 'No file selected';
      this.setDirtyCanvas(true);
      return;
    }

    this._status = 'loading';
    this._error = null;
    this.setDirtyCanvas(true);

    try {
      let data;
      const freq = this.widgets[1].value;
      const pol = this.widgets[2].value;
      const mode = this.widgets[3].value;
      const composite = this.widgets[4].value;

      if (this._fileType === 'nisar') {
        if (mode === 'rgb' && composite) {
          const requiredPols = getRequiredDatasets(composite);
          const requiredComplexPols = getRequiredComplexDatasets(composite);

          data = await loadNISARRGBComposite(this._file, {
            frequency: freq,
            compositeId: composite,
            requiredPols,
            requiredComplexPols,
          });
          data.getTile = data.getRGBTile;
        } else {
          data = await loadNISARGCOV(this._file, {
            frequency: freq,
            polarization: pol,
          });
        }
      } else {
        // COG from local file — create object URL
        const { loadCOG } = await import('../../loaders/cog-loader.js');
        const objectUrl = URL.createObjectURL(this._file);
        data = await loadCOG(objectUrl);
      }

      this._imageData = data;
      this._status = 'ready';

      // Set outputs
      this.setOutputData(0, {
        url: null, // local file, no URL
        name: this._fileName,
        size: this._file.size,
        type: this._fileType,
        localFile: this._file,
      });
      this.setOutputData(1, data);
      this.setOutputData(2, this._datasets);

      this.triggerSlot(1, data);
    } catch (e) {
      this._status = 'error';
      this._error = e.message;
    }
    this.setDirtyCanvas(true);
  };

  FileInputNode.prototype.onExecute = async function () {
    return [
      this._file ? { url: null, name: this._fileName, size: this._file?.size, type: this._fileType, localFile: this._file } : null,
      this._imageData,
      this._datasets,
    ];
  };

  FileInputNode.prototype.onDrawForeground = function (ctx) {
    const statusColors = {
      idle: '#5a7099',
      selected: '#e8833a',
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

    // File name
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'left';

    if (this._fileName) {
      ctx.fillStyle = '#4ec9d4';
      const name = this._fileName.length > 32
        ? this._fileName.substring(0, 29) + '...'
        : this._fileName;
      ctx.fillText(name, 8, this.size[1] - 28);
    }

    // Status text
    const y = this.size[1] - 12;
    if (this._error) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText(this._error.substring(0, 38), 8, y);
    } else if (this._status === 'scanned') {
      ctx.fillStyle = '#8fa4c4';
      ctx.fillText(`${this._datasets.length} datasets found`, 8, y);
    } else if (this._status === 'loading') {
      ctx.fillStyle = '#4ec9d4';
      ctx.fillText('Loading...', 8, y);
    } else if (this._status === 'ready' && this._imageData) {
      ctx.fillStyle = '#3ddc84';
      ctx.fillText(`${this._imageData.width}\u00D7${this._imageData.height}`, 8, y);
    } else if (this._status === 'idle') {
      ctx.fillStyle = '#5a7099';
      ctx.fillText('Drop or choose .h5 / .tif', 8, y);
    }

    // Draw file icon when idle
    if (this._status === 'idle') {
      ctx.strokeStyle = '#5a7099';
      ctx.lineWidth = 1;
      // File icon shape
      const ix = this.size[0] / 2 - 12;
      const iy = 40;
      ctx.beginPath();
      ctx.moveTo(ix, iy);
      ctx.lineTo(ix + 16, iy);
      ctx.lineTo(ix + 24, iy + 8);
      ctx.lineTo(ix + 24, iy + 28);
      ctx.lineTo(ix, iy + 28);
      ctx.closePath();
      ctx.stroke();
      // Fold corner
      ctx.beginPath();
      ctx.moveTo(ix + 16, iy);
      ctx.lineTo(ix + 16, iy + 8);
      ctx.lineTo(ix + 24, iy + 8);
      ctx.stroke();
    }
  };

  /**
   * Support drag-and-drop onto the node.
   */
  FileInputNode.prototype.onDropFile = function (file) {
    if (!file) return;
    this._file = file;
    this._fileName = file.name;

    if (isNISARFile(file.name)) {
      this._fileType = 'nisar';
    } else if (isCOGFile(file.name)) {
      this._fileType = 'cog';
    } else {
      this._fileType = 'nisar';
    }

    this._status = 'selected';
    this.setDirtyCanvas(true);

    if (this._fileType === 'nisar') {
      this._scanDatasets();
    }
  };

  LiteGraph.registerNodeType('sardine/FileInput', FileInputNode);
  FileInputNode.category = CATEGORY;
}
