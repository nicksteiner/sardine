/**
 * Workflow Presets — Built-in litegraph.js graph configurations.
 *
 * These are litegraph.js serialized graph objects (graph.serialize() output).
 * Each preset defines a complete workflow that can be loaded with graph.configure().
 *
 * Presets define the node positions, widget values, and connections
 * for common SARdine pipelines.
 */

/**
 * Default workflow: S3 Discovery -> NISAR Loader -> Statistics -> Render Config -> Viewer
 *
 * The simplest useful pipeline — browse S3, load a single NISAR band, auto-contrast, display.
 */
export const DEFAULT_WORKFLOW = {
  last_node_id: 5,
  last_link_id: 4,
  nodes: [
    {
      id: 1,
      type: 'sardine/S3Discovery',
      pos: [50, 80],
      size: [320, 230],
      flags: {},
      order: 0,
      mode: 0,
      outputs: [
        { name: 'file_info', type: 'file_info', links: [1] },
      ],
      properties: {},
    },
    {
      id: 2,
      type: 'sardine/NISARLoader',
      pos: [420, 80],
      size: [300, 230],
      flags: {},
      order: 1,
      mode: 0,
      inputs: [
        { name: 'file_info', type: 'file_info', link: 1 },
      ],
      outputs: [
        { name: 'image_data', type: 'image_data', links: [2, 3] },
        { name: 'datasets', type: 'dataset_list', links: null },
      ],
      properties: {},
    },
    {
      id: 3,
      type: 'sardine/Statistics',
      pos: [770, 30],
      size: [220, 130],
      flags: {},
      order: 2,
      mode: 0,
      inputs: [
        { name: 'image_data', type: 'image_data', link: 2 },
      ],
      outputs: [
        { name: 'stats', type: 'stats', links: null },
        { name: 'contrast', type: 'contrast', links: [4] },
      ],
      properties: {},
    },
    {
      id: 4,
      type: 'sardine/RenderConfig',
      pos: [770, 200],
      size: [260, 200],
      flags: {},
      order: 3,
      mode: 0,
      inputs: [
        { name: 'contrast', type: 'contrast', link: 4 },
      ],
      outputs: [
        { name: 'render_params', type: 'render_params', links: [5] },
      ],
      properties: {},
    },
    {
      id: 5,
      type: 'sardine/Viewer',
      pos: [1080, 100],
      size: [240, 130],
      flags: {},
      order: 4,
      mode: 0,
      inputs: [
        { name: 'image_data', type: 'image_data', link: 3 },
        { name: 'render_params', type: 'render_params', link: 5 },
      ],
      properties: {},
    },
  ],
  links: [
    [1, 1, 0, 2, 0, 'file_info'],     // Discovery -> Loader (file_info)
    [2, 2, 0, 3, 0, 'image_data'],     // Loader -> Statistics (image_data)
    [3, 2, 0, 5, 0, 'image_data'],     // Loader -> Viewer (image_data)
    [4, 3, 1, 4, 0, 'contrast'],       // Statistics -> RenderConfig (contrast)
    [5, 4, 0, 5, 1, 'render_params'],  // RenderConfig -> Viewer (render_params)
  ],
  groups: [],
  config: {},
  extra: {},
  version: 0.4,
};

/**
 * RGB Composite workflow: Discovery -> Loader (rgb mode) -> Render -> Viewer
 */
export const RGB_WORKFLOW = {
  last_node_id: 5,
  last_link_id: 4,
  nodes: [
    {
      id: 1,
      type: 'sardine/S3Discovery',
      pos: [50, 80],
      size: [320, 230],
      flags: {},
      order: 0,
      mode: 0,
      outputs: [
        { name: 'file_info', type: 'file_info', links: [1] },
      ],
      properties: {},
    },
    {
      id: 2,
      type: 'sardine/NISARLoader',
      pos: [420, 80],
      size: [300, 230],
      flags: {},
      order: 1,
      mode: 0,
      inputs: [
        { name: 'file_info', type: 'file_info', link: 1 },
      ],
      outputs: [
        { name: 'image_data', type: 'image_data', links: [2] },
        { name: 'datasets', type: 'dataset_list', links: null },
      ],
      properties: {},
      widgets_values: ['A', 'HHHH', 'rgb', 'dual-pol-h'],
    },
    {
      id: 4,
      type: 'sardine/RenderConfig',
      pos: [770, 80],
      size: [260, 200],
      flags: {},
      order: 2,
      mode: 0,
      inputs: [
        { name: 'contrast', type: 'contrast', link: null },
      ],
      outputs: [
        { name: 'render_params', type: 'render_params', links: [3] },
      ],
      properties: {},
      widgets_values: ['grayscale', false, 'linear', 1.0, 0, 1],
    },
    {
      id: 5,
      type: 'sardine/Viewer',
      pos: [1080, 100],
      size: [240, 130],
      flags: {},
      order: 3,
      mode: 0,
      inputs: [
        { name: 'image_data', type: 'image_data', link: 2 },
        { name: 'render_params', type: 'render_params', link: 3 },
      ],
      properties: {},
    },
  ],
  links: [
    [1, 1, 0, 2, 0, 'file_info'],
    [2, 2, 0, 5, 0, 'image_data'],
    [3, 4, 0, 5, 1, 'render_params'],
  ],
  groups: [],
  config: {},
  extra: {},
  version: 0.4,
};

/**
 * Export pipeline: Discovery -> Loader -> Stats -> Render -> Viewer + Export
 */
export const EXPORT_WORKFLOW = {
  last_node_id: 6,
  last_link_id: 6,
  nodes: [
    {
      id: 1,
      type: 'sardine/S3Discovery',
      pos: [50, 80],
      size: [320, 230],
      flags: {},
      order: 0,
      mode: 0,
      outputs: [
        { name: 'file_info', type: 'file_info', links: [1] },
      ],
      properties: {},
    },
    {
      id: 2,
      type: 'sardine/NISARLoader',
      pos: [420, 80],
      size: [300, 230],
      flags: {},
      order: 1,
      mode: 0,
      inputs: [
        { name: 'file_info', type: 'file_info', link: 1 },
      ],
      outputs: [
        { name: 'image_data', type: 'image_data', links: [2, 3, 6] },
        { name: 'datasets', type: 'dataset_list', links: null },
      ],
      properties: {},
    },
    {
      id: 3,
      type: 'sardine/Statistics',
      pos: [770, 30],
      size: [220, 130],
      flags: {},
      order: 2,
      mode: 0,
      inputs: [
        { name: 'image_data', type: 'image_data', link: 2 },
      ],
      outputs: [
        { name: 'stats', type: 'stats', links: null },
        { name: 'contrast', type: 'contrast', links: [4] },
      ],
      properties: {},
    },
    {
      id: 4,
      type: 'sardine/RenderConfig',
      pos: [770, 200],
      size: [260, 200],
      flags: {},
      order: 3,
      mode: 0,
      inputs: [
        { name: 'contrast', type: 'contrast', link: 4 },
      ],
      outputs: [
        { name: 'render_params', type: 'render_params', links: [5, 7] },
      ],
      properties: {},
    },
    {
      id: 5,
      type: 'sardine/Viewer',
      pos: [1080, 50],
      size: [240, 130],
      flags: {},
      order: 4,
      mode: 0,
      inputs: [
        { name: 'image_data', type: 'image_data', link: 3 },
        { name: 'render_params', type: 'render_params', link: 5 },
      ],
      properties: {},
    },
    {
      id: 6,
      type: 'sardine/Export',
      pos: [1080, 230],
      size: [240, 160],
      flags: {},
      order: 5,
      mode: 0,
      inputs: [
        { name: 'image_data', type: 'image_data', link: 6 },
        { name: 'render_params', type: 'render_params', link: 7 },
      ],
      properties: {},
    },
  ],
  links: [
    [1, 1, 0, 2, 0, 'file_info'],
    [2, 2, 0, 3, 0, 'image_data'],
    [3, 2, 0, 5, 0, 'image_data'],
    [4, 3, 1, 4, 0, 'contrast'],
    [5, 4, 0, 5, 1, 'render_params'],
    [6, 2, 0, 6, 0, 'image_data'],
    [7, 4, 0, 6, 1, 'render_params'],
  ],
  groups: [],
  config: {},
  extra: {},
  version: 0.4,
};

/**
 * All preset workflows indexed by name.
 */
export const PRESET_WORKFLOWS = {
  default: DEFAULT_WORKFLOW,
  rgb: RGB_WORKFLOW,
  export: EXPORT_WORKFLOW,
};
