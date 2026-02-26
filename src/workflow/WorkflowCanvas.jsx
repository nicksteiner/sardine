/**
 * WorkflowCanvas — React wrapper for litegraph.js Canvas2D graph editor.
 *
 * Renders the litegraph.js node graph in a Canvas element that fills
 * the left panel of the SARdine UI. Handles initialization, node
 * registration, theme customization, and bridging graph outputs
 * back to the React application state.
 *
 * The canvas is GPU-accelerated via Canvas2D hardware acceleration
 * (enabled by default in modern browsers).
 */
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { LiteGraph, LGraph, LGraphCanvas } from 'litegraph.js';
import 'litegraph.js/css/litegraph.css';
import { registerAllNodes } from './nodes/index.js';
import { executeGraph, serializeWorkflow, deserializeWorkflow } from './engine.js';
import { DEFAULT_WORKFLOW, PRESET_WORKFLOWS } from './presets.js';

// Expose LiteGraph globally for node registration
if (typeof window !== 'undefined') {
  window.LiteGraph = LiteGraph;
}

/**
 * Apply SARdine dark theme to litegraph.js globals.
 * litegraph uses global style properties on the LiteGraph and LGraphCanvas objects.
 */
function applySardineTheme() {
  // Node colors
  LiteGraph.NODE_DEFAULT_COLOR = '#0f1f38';
  LiteGraph.NODE_DEFAULT_BGCOLOR = '#0a1628';
  LiteGraph.NODE_DEFAULT_BOXCOLOR = '#1e3a5f';
  LiteGraph.NODE_TITLE_COLOR = '#e8edf5';
  LiteGraph.NODE_TEXT_COLOR = '#8fa4c4';
  LiteGraph.NODE_SELECTED_TITLE_COLOR = '#4ec9d4';
  LiteGraph.NODE_TEXT_SIZE = 12;
  LiteGraph.NODE_TITLE_TEXT_Y = 18;

  // Links
  LiteGraph.LINK_COLOR = '#4ec9d4';
  LiteGraph.EVENT_LINK_COLOR = '#e8833a';
  LiteGraph.CONNECTING_LINK_COLOR = '#4ec9d4';

  // Background
  LGraphCanvas.DEFAULT_BACKGROUND_COLOR = '#080e1a';

  // Widget colors
  LiteGraph.WIDGET_BGCOLOR = '#122240';
  LiteGraph.WIDGET_OUTLINE_COLOR = '#1e3a5f';
  LiteGraph.WIDGET_TEXT_COLOR = '#8fa4c4';
  LiteGraph.WIDGET_SECONDARY_TEXT_COLOR = '#5a7099';
}

/**
 * WorkflowCanvas React component.
 *
 * @param {Object} props
 * @param {function} props.onViewerUpdate - Called when Viewer node has data: ({ imageData, renderParams, ... })
 * @param {function} [props.onStatusLog] - Called with (type, message) for status logging
 * @param {string} [props.className] - Additional CSS class
 */
export function WorkflowCanvas({ onViewerUpdate, onStatusLog, className = '' }) {
  const canvasRef = useRef(null);
  const graphRef = useRef(null);
  const canvasInstanceRef = useRef(null);
  const [isReady, setIsReady] = useState(false);

  // Initialize litegraph
  useEffect(() => {
    if (!canvasRef.current) return;

    // Apply theme before creating graph
    applySardineTheme();

    // Register all SARdine node types
    registerAllNodes(LiteGraph);

    // Create graph and canvas
    const graph = new LGraph();
    const canvas = new LGraphCanvas(canvasRef.current, graph);

    // Canvas settings
    canvas.background_image = null; // No default grid image
    canvas.render_shadows = false;
    canvas.render_curved_connections = true;
    canvas.render_connection_arrows = true;
    canvas.always_render_background = true;
    canvas.show_info = false; // Hide default info overlay

    // Font
    canvas.title_text_font = '13px JetBrains Mono, monospace';
    canvas.inner_text_font = '11px JetBrains Mono, monospace';

    graphRef.current = graph;
    canvasInstanceRef.current = canvas;

    // Load default workflow
    loadPreset(graph, 'default');

    // Wire up Viewer node callback
    wireViewerNodes(graph, onViewerUpdate);

    // Start the graph
    graph.start();
    setIsReady(true);

    onStatusLog?.('info', 'Workflow editor initialized');

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (canvasRef.current) {
        canvas.resize(canvasRef.current.parentElement.clientWidth, canvasRef.current.parentElement.clientHeight);
      }
    });
    if (canvasRef.current.parentElement) {
      resizeObserver.observe(canvasRef.current.parentElement);
    }

    return () => {
      graph.stop();
      resizeObserver.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update viewer callback when it changes
  useEffect(() => {
    if (graphRef.current) {
      wireViewerNodes(graphRef.current, onViewerUpdate);
    }
  }, [onViewerUpdate]);

  // Run workflow
  const handleRun = useCallback(async () => {
    if (!graphRef.current) return;
    onStatusLog?.('info', 'Executing workflow...');

    try {
      await executeGraph(graphRef.current, {
        onNodeStart: (id, title) => {
          onStatusLog?.('info', `Running: ${title}`);
        },
        onNodeComplete: (id, title) => {
          onStatusLog?.('success', `Completed: ${title}`);
        },
        onNodeError: (id, title, err) => {
          onStatusLog?.('error', `Error in ${title}: ${err.message}`);
        },
        onOutput: (type, result, nodeId) => {
          if (type === 'sardine/Viewer') {
            onViewerUpdate?.(result);
          }
        },
      });
      onStatusLog?.('success', 'Workflow execution complete');
    } catch (e) {
      onStatusLog?.('error', `Workflow failed: ${e.message}`);
    }
  }, [onViewerUpdate, onStatusLog]);

  // Save workflow
  const handleSave = useCallback(() => {
    if (!graphRef.current) return;
    const workflow = graphRef.current.serialize();
    const json = JSON.stringify(workflow, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sardine-workflow.json';
    a.click();
    URL.revokeObjectURL(url);
    onStatusLog?.('success', 'Workflow saved');
  }, [onStatusLog]);

  // Load workflow
  const handleLoad = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const workflow = JSON.parse(ev.target.result);
          graphRef.current?.configure(workflow);
          wireViewerNodes(graphRef.current, onViewerUpdate);
          onStatusLog?.('success', 'Workflow loaded');
        } catch (err) {
          onStatusLog?.('error', `Failed to load workflow: ${err.message}`);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [onViewerUpdate, onStatusLog]);

  // Load preset
  const handlePreset = useCallback((presetName) => {
    if (!graphRef.current) return;
    loadPreset(graphRef.current, presetName);
    wireViewerNodes(graphRef.current, onViewerUpdate);
    onStatusLog?.('info', `Loaded preset: ${presetName}`);
  }, [onViewerUpdate, onStatusLog]);

  return (
    <div className={`workflow-editor ${className}`}>
      {/* Toolbar */}
      <div className="workflow-toolbar">
        <button className="workflow-btn workflow-btn-run" onClick={handleRun} title="Execute workflow">
          Run
        </button>
        <div className="workflow-toolbar-separator" />
        <button className="workflow-btn" onClick={handleSave} title="Save workflow JSON">
          Save
        </button>
        <button className="workflow-btn" onClick={handleLoad} title="Load workflow JSON">
          Load
        </button>
        <div className="workflow-toolbar-separator" />
        <select
          className="workflow-preset-select"
          onChange={(e) => {
            if (e.target.value) handlePreset(e.target.value);
            e.target.value = '';
          }}
          defaultValue=""
        >
          <option value="" disabled>Presets...</option>
          <option value="default">Single Band</option>
          <option value="rgb">RGB Composite</option>
          <option value="export">Export Pipeline</option>
        </select>
      </div>

      {/* litegraph.js Canvas */}
      <canvas ref={canvasRef} className="workflow-canvas" />
    </div>
  );
}

/**
 * Wire up all Viewer nodes in the graph to the React callback.
 */
function wireViewerNodes(graph, onViewerUpdate) {
  if (!graph?._nodes) return;
  for (const node of graph._nodes) {
    if (node.type === 'sardine/Viewer' && onViewerUpdate) {
      node._onViewerUpdate = onViewerUpdate;
    }
  }
}

/**
 * Load a preset workflow into the graph.
 */
function loadPreset(graph, presetName) {
  const preset = PRESET_WORKFLOWS[presetName] || DEFAULT_WORKFLOW;
  graph.configure(preset);
}
