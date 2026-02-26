/**
 * S3 Discovery Node — Browse S3 / HTTP buckets and select files.
 *
 * Client-side node that wraps bucket-browser.js functionality.
 * Outputs a file_info object when the user selects a file.
 *
 * litegraph.js custom node registered as "sardine/S3Discovery".
 */
import { PORT_TYPES, PORT_COLORS } from '../engine.js';
import {
  listBucket,
  listBucketViaServer,
  buildFileUrl,
  displayName,
  isNISARFile,
  isCOGFile,
  PRESET_BUCKETS,
  resolvePresetUrl,
} from '../../utils/bucket-browser.js';

const CATEGORY = 'sardine/sources';

export function registerDiscoveryNode(LiteGraph) {

  function S3DiscoveryNode() {
    // Outputs
    this.addOutput('file_info', PORT_TYPES.FILE_INFO);

    // Widgets (user-configurable parameters)
    this.addWidget('combo', 'preset', '(custom)', {
      values: ['(custom)', ...PRESET_BUCKETS.map(p => p.label)],
    });
    this.addWidget('text', 'bucket_url', '');
    this.addWidget('combo', 'browse_mode', 'direct', { values: ['direct', 'server-s3'] });
    this.addWidget('text', 'region', 'us-west-2');
    this.addWidget('button', 'Browse', '', () => this._browse());
    this.addWidget('button', 'Select', '', () => this._selectFile());

    // Internal state
    this._directories = [];
    this._files = [];
    this._prefix = '';
    this._selectedFile = null;
    this._status = 'idle';
    this._error = null;

    this.title = 'S3 Discovery';
    this.size = [320, 230];
    this.color = '#1a2d50';
    this.bgcolor = '#0f1f38';
  }

  S3DiscoveryNode.title = 'S3 Discovery';
  S3DiscoveryNode.desc = 'Browse S3 buckets and select files for loading';

  S3DiscoveryNode.prototype.onAdded = function () {
    // Set colors for output slot
    if (this.outputs && this.outputs[0]) {
      this.outputs[0].color_on = PORT_COLORS[PORT_TYPES.FILE_INFO];
      this.outputs[0].color_off = PORT_COLORS[PORT_TYPES.FILE_INFO];
    }
  };

  S3DiscoveryNode.prototype._getUrl = function () {
    const preset = this.widgets[0].value;
    if (preset !== '(custom)') {
      const match = PRESET_BUCKETS.find(p => p.label === preset);
      return match ? resolvePresetUrl(match) : '';
    }
    return this.widgets[1].value;
  };

  S3DiscoveryNode.prototype._browse = async function () {
    const url = this._getUrl();
    if (!url) return;

    this._status = 'browsing';
    this._error = null;
    this.setDirtyCanvas(true);

    try {
      const browseMode = this.widgets[2].value;
      const region = this.widgets[3].value;

      let result;
      if (browseMode === 'server-s3') {
        result = await listBucketViaServer('', url, this._prefix, region);
      } else {
        result = await listBucket(url + this._prefix);
      }

      this._directories = result.directories || [];
      this._files = result.files || [];
      this._status = 'ready';

      // Auto-select first NISAR or COG file found
      const sarFile = this._files.find(f => isNISARFile(f.name) || isCOGFile(f.name));
      if (sarFile) {
        this._selectedFile = sarFile;
      }
    } catch (e) {
      this._status = 'error';
      this._error = e.message;
    }

    this.setDirtyCanvas(true);
  };

  S3DiscoveryNode.prototype._selectFile = function () {
    if (!this._selectedFile) return;

    const url = this._getUrl();
    const file = this._selectedFile;
    const fileUrl = buildFileUrl(url, file.key || file.name);
    const type = isNISARFile(file.name) ? 'nisar' : 'cog';

    this._outputFileInfo = {
      url: fileUrl,
      name: displayName(file.name || file.key),
      size: file.size || 0,
      type,
      key: file.key,
    };

    this._status = 'selected';
    this.setDirtyCanvas(true);
    this.triggerSlot(0, this._outputFileInfo);
  };

  S3DiscoveryNode.prototype.onExecute = async function () {
    if (this._outputFileInfo) {
      return [this._outputFileInfo];
    }
    return [null];
  };

  S3DiscoveryNode.prototype.onDrawForeground = function (ctx) {
    // Draw status indicator
    const statusColors = {
      idle: '#5a7099',
      browsing: '#4ec9d4',
      ready: '#3ddc84',
      selected: '#3ddc84',
      error: '#ff6b6b',
    };

    ctx.fillStyle = statusColors[this._status] || '#5a7099';
    ctx.beginPath();
    ctx.arc(this.size[0] - 15, 15, 5, 0, Math.PI * 2);
    ctx.fill();

    // Draw file count or error
    ctx.fillStyle = '#8fa4c4';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'left';

    const y = this.size[1] - 12;
    if (this._error) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText(this._error.substring(0, 40), 8, y);
    } else if (this._status === 'ready' || this._status === 'selected') {
      ctx.fillText(`${this._files.length} files, ${this._directories.length} dirs`, 8, y);
    } else if (this._status === 'browsing') {
      ctx.fillText('Browsing...', 8, y);
    }

    // Show selected file
    if (this._selectedFile) {
      ctx.fillStyle = '#4ec9d4';
      const name = displayName(this._selectedFile.name || this._selectedFile.key);
      ctx.fillText(name.substring(0, 35), 8, y - 15);
    }
  };

  // Register with litegraph
  LiteGraph.registerNodeType('sardine/S3Discovery', S3DiscoveryNode);
  S3DiscoveryNode.category = CATEGORY;
}
