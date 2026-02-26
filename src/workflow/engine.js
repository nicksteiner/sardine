/**
 * Workflow Engine — DAG execution with topological sort, caching, and async support.
 *
 * Evaluates a litegraph.js graph by walking nodes in dependency order.
 * Each node wraps a SARdine function (loader, stats, render config, etc.)
 * and produces typed outputs consumed by downstream nodes.
 *
 * The engine runs client-side for Phase 1.
 * Phase 2 adds server-side execution via WebSocket for Python plugin nodes.
 */

/**
 * Port type definitions — determine which connections are valid.
 * litegraph uses string type names on slots; we define them here for consistency.
 */
export const PORT_TYPES = {
  // Primitives
  STRING:     'string',
  NUMBER:     'number',
  BOOLEAN:    'boolean',

  // File/discovery types
  FILE_INFO:    'file_info',     // { url, name, size, type, key, shardUrls }
  FILE_LIST:    'file_list',     // Array of FILE_INFO
  DATASET_LIST: 'dataset_list',  // [{ frequency, polarization, shape, ... }]

  // Core SAR data types
  IMAGE_DATA:    'image_data',    // { getTile, bounds, crs, width, height, ... }
  TILE_DATA:     'tile_data',     // { data: Float32Array, width, height }
  STATS:         'stats',         // { min, max, mean, std, hist, p2, p98, ... }
  CONTRAST:      'contrast',      // [min, max] or { R: [min,max], G: ..., B: ... }

  // Render config
  RENDER_PARAMS: 'render_params', // { contrastLimits, colormap, useDecibels, ... }

  // Export
  BUFFER:  'buffer',  // ArrayBuffer (GeoTIFF, PNG)
  CANVAS:  'canvas',  // HTMLCanvasElement

  // Future ML
  TENSOR:    'tensor',     // Float32Array + shape metadata
  CLASS_MAP: 'class_map',  // Uint8Array classification result
};

/**
 * Color mapping for port types — used by litegraph slot rendering.
 * Matches SARdine design system accents.
 */
export const PORT_COLORS = {
  [PORT_TYPES.STRING]:       '#8fa4c4',
  [PORT_TYPES.NUMBER]:       '#8fa4c4',
  [PORT_TYPES.BOOLEAN]:      '#8fa4c4',
  [PORT_TYPES.FILE_INFO]:    '#e8833a', // orange
  [PORT_TYPES.FILE_LIST]:    '#e8833a',
  [PORT_TYPES.DATASET_LIST]: '#e8833a',
  [PORT_TYPES.IMAGE_DATA]:   '#4ec9d4', // cyan
  [PORT_TYPES.TILE_DATA]:    '#4ec9d4',
  [PORT_TYPES.STATS]:        '#3ddc84', // green
  [PORT_TYPES.CONTRAST]:     '#3ddc84',
  [PORT_TYPES.RENDER_PARAMS]: '#d45cff', // magenta
  [PORT_TYPES.BUFFER]:       '#f0c040',
  [PORT_TYPES.CANVAS]:       '#f0c040',
  [PORT_TYPES.TENSOR]:       '#ff6b6b',
  [PORT_TYPES.CLASS_MAP]:    '#ff6b6b',
};

/** Cache entry for a node's last execution result. */
class NodeCache {
  constructor() {
    this._cache = new Map(); // nodeId -> { paramsHash, outputs }
  }

  /**
   * Get cached output for a node if params haven't changed.
   * Uses shallow comparison of serializable params + reference identity for data objects.
   */
  get(nodeId, paramsHash) {
    const entry = this._cache.get(nodeId);
    if (entry && entry.paramsHash === paramsHash) {
      return entry.outputs;
    }
    return null;
  }

  set(nodeId, paramsHash, outputs) {
    this._cache.set(nodeId, { paramsHash, outputs });
  }

  invalidate(nodeId) {
    this._cache.delete(nodeId);
  }

  invalidateAll() {
    this._cache.clear();
  }
}

/**
 * Compute a simple hash of node parameters for cache comparison.
 * For large data objects (imageData), uses a reference counter rather than deep comparison.
 */
let _refCounter = 0;
const _refMap = new WeakMap();

export function stableHash(params) {
  const parts = [];
  for (const [key, val] of Object.entries(params)) {
    if (val === null || val === undefined) {
      parts.push(`${key}:null`);
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      // For data objects, use reference identity
      if (!_refMap.has(val)) {
        _refMap.set(val, ++_refCounter);
      }
      parts.push(`${key}:ref${_refMap.get(val)}`);
    } else {
      parts.push(`${key}:${JSON.stringify(val)}`);
    }
  }
  return parts.join('|');
}

/**
 * Topological sort using Kahn's algorithm.
 * @param {Map<string, Set<string>>} adjacency - nodeId -> Set of downstream nodeIds
 * @param {Map<string, Set<string>>} inDegreeMap - nodeId -> Set of upstream nodeIds
 * @returns {string[]} Sorted node IDs (sources first)
 */
function topologicalSort(adjacency, inDegreeMap) {
  const inDegree = new Map();
  for (const [nodeId, deps] of inDegreeMap) {
    inDegree.set(nodeId, deps.size);
  }
  // Add nodes with no dependencies
  for (const nodeId of adjacency.keys()) {
    if (!inDegree.has(nodeId)) {
      inDegree.set(nodeId, 0);
    }
  }

  const queue = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) queue.push(nodeId);
  }

  const sorted = [];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    sorted.push(nodeId);
    const downstream = adjacency.get(nodeId) || new Set();
    for (const next of downstream) {
      const newDegree = inDegree.get(next) - 1;
      inDegree.set(next, newDegree);
      if (newDegree === 0) {
        queue.push(next);
      }
    }
  }

  return sorted;
}

/**
 * Build adjacency and in-degree maps from a litegraph LGraph.
 * litegraph stores links as: [link_id, origin_id, origin_slot, target_id, target_slot, type]
 */
export function buildGraphMaps(graph) {
  const adjacency = new Map();   // nodeId -> Set<downstream nodeIds>
  const inDegreeMap = new Map(); // nodeId -> Set<upstream nodeIds>

  // Initialize all nodes
  const nodes = graph._nodes || [];
  for (const node of nodes) {
    const id = String(node.id);
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    if (!inDegreeMap.has(id)) inDegreeMap.set(id, new Set());
  }

  // Process links
  const links = graph.links || {};
  for (const linkId in links) {
    const link = links[linkId];
    if (!link) continue;
    const sourceId = String(link[1]);
    const targetId = String(link[3]);
    adjacency.get(sourceId)?.add(targetId);
    inDegreeMap.get(targetId)?.add(sourceId);
  }

  return { adjacency, inDegreeMap };
}

/**
 * Execute a litegraph graph by walking nodes in topological order.
 *
 * @param {LGraph} graph - The litegraph graph instance
 * @param {Object} callbacks - { onNodeStart, onNodeComplete, onNodeError, onOutput }
 * @param {number} generation - Monotonically increasing counter to detect stale executions
 * @returns {Promise<Map<string, any>>} Node outputs keyed by node ID
 */
export async function executeGraph(graph, callbacks = {}, generation = 0) {
  const cache = new NodeCache();
  const { adjacency, inDegreeMap } = buildGraphMaps(graph);
  const sortedIds = topologicalSort(adjacency, inDegreeMap);
  const outputs = new Map();

  for (const nodeId of sortedIds) {
    const node = graph.getNodeById(parseInt(nodeId));
    if (!node || !node.onExecute) continue;

    callbacks.onNodeStart?.(nodeId, node.title);

    try {
      // Gather inputs from upstream connected nodes
      const inputs = {};
      if (node.inputs) {
        for (let i = 0; i < node.inputs.length; i++) {
          const input = node.inputs[i];
          if (input.link != null) {
            const link = graph.links[input.link];
            if (link) {
              const sourceId = String(link[1]);
              const sourceSlot = link[2];
              const sourceOutputs = outputs.get(sourceId);
              if (sourceOutputs) {
                inputs[input.name] = sourceOutputs[sourceSlot];
              }
            }
          }
        }
      }

      // Execute the node (async-capable)
      const result = await node.onExecute(inputs);
      outputs.set(nodeId, result || []);

      callbacks.onNodeComplete?.(nodeId, node.title, result);

      // If this is a sink node (viewer/export), notify via callback
      if (node.isSink && result) {
        callbacks.onOutput?.(node.type, result, nodeId);
      }
    } catch (err) {
      console.error(`[Workflow] Node ${nodeId} (${node.title}) failed:`, err);
      callbacks.onNodeError?.(nodeId, node.title, err);
      // Don't propagate — downstream nodes will have missing inputs
    }
  }

  return outputs;
}

/**
 * Serialize a litegraph graph to ComfyUI-compatible workflow JSON.
 */
export function serializeWorkflow(graph) {
  const workflow = {};
  const nodes = graph._nodes || [];

  for (const node of nodes) {
    const nodeData = {
      class_type: node.type,
      inputs: {},
    };

    // Collect widget values (static params)
    if (node.widgets) {
      for (const widget of node.widgets) {
        nodeData.inputs[widget.name] = widget.value;
      }
    }

    // Collect connected inputs as [source_id, output_slot] references
    if (node.inputs) {
      for (let i = 0; i < node.inputs.length; i++) {
        const input = node.inputs[i];
        if (input.link != null) {
          const link = graph.links[input.link];
          if (link) {
            nodeData.inputs[input.name] = [String(link[1]), link[2]];
          }
        }
      }
    }

    workflow[String(node.id)] = nodeData;
  }

  return workflow;
}

/**
 * Load a ComfyUI-compatible workflow JSON into a litegraph graph.
 */
export function deserializeWorkflow(graph, workflow, nodePositions = {}) {
  graph.clear();

  const idMap = new Map(); // old string id -> new litegraph node

  // Create nodes
  for (const [id, nodeData] of Object.entries(workflow)) {
    const node = window.LiteGraph.createNode(nodeData.class_type);
    if (!node) {
      console.warn(`[Workflow] Unknown node type: ${nodeData.class_type}`);
      continue;
    }

    const pos = nodePositions[id] || { x: 100 + parseInt(id) * 250, y: 100 };
    node.pos = [pos.x, pos.y];

    // Set widget values from static inputs
    if (node.widgets && nodeData.inputs) {
      for (const widget of node.widgets) {
        if (widget.name in nodeData.inputs && !Array.isArray(nodeData.inputs[widget.name])) {
          widget.value = nodeData.inputs[widget.name];
        }
      }
    }

    graph.add(node);
    idMap.set(id, node);
  }

  // Create connections
  for (const [id, nodeData] of Object.entries(workflow)) {
    const targetNode = idMap.get(id);
    if (!targetNode) continue;

    for (const [inputName, value] of Object.entries(nodeData.inputs)) {
      if (Array.isArray(value) && value.length === 2) {
        const [sourceId, sourceSlot] = value;
        const sourceNode = idMap.get(String(sourceId));
        if (sourceNode && targetNode.inputs) {
          const targetSlot = targetNode.inputs.findIndex(inp => inp.name === inputName);
          if (targetSlot >= 0) {
            sourceNode.connect(sourceSlot, targetNode, targetSlot);
          }
        }
      }
    }
  }
}
