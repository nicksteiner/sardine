/**
 * Node Registry — Register all SARdine litegraph.js node types.
 *
 * Call registerAllNodes(LiteGraph) once at startup to make
 * all sardine/* node types available in the graph editor.
 */
import { registerDiscoveryNode } from './discovery-node.js';
import { registerFileInputNode } from './file-input-node.js';
import { registerLoaderNode, registerCOGLoaderNode } from './loader-node.js';
import { registerRenderNode, registerStatisticsNode } from './render-node.js';
import { registerViewerNode, registerExportNode } from './viewer-node.js';

/**
 * Register all SARdine workflow node types with litegraph.
 * @param {LiteGraph} LiteGraph - The litegraph.js LiteGraph global
 */
export function registerAllNodes(LiteGraph) {
  // Sources
  registerDiscoveryNode(LiteGraph);
  registerFileInputNode(LiteGraph);

  // Loaders
  registerLoaderNode(LiteGraph);
  registerCOGLoaderNode(LiteGraph);

  // Processing
  registerStatisticsNode(LiteGraph);

  // Render configuration
  registerRenderNode(LiteGraph);

  // Sinks
  registerViewerNode(LiteGraph);
  registerExportNode(LiteGraph);
}

/**
 * Node categories for the palette/context menu.
 */
export const NODE_CATEGORIES = [
  {
    label: 'Sources',
    types: ['sardine/S3Discovery', 'sardine/FileInput'],
  },
  {
    label: 'Loaders',
    types: ['sardine/NISARLoader', 'sardine/COGLoader'],
  },
  {
    label: 'Processing',
    types: ['sardine/Statistics'],
  },
  {
    label: 'Render',
    types: ['sardine/RenderConfig'],
  },
  {
    label: 'Output',
    types: ['sardine/Viewer', 'sardine/Export'],
  },
];
