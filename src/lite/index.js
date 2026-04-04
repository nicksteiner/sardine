/**
 * sardine-lite — lightweight, dependency-free chart renderers for report graphics.
 *
 * All renderers use the Canvas 2D API only. Safe for browser, OffscreenCanvas,
 * or node-canvas environments without any heavy SARdine dependencies.
 */

export {
  drawDbBarChart,
  drawChangeDetectionPlot,
  drawFootprintMap,
  drawRegionEstimates,
  drawTimelinePlot,
  drawHorizontalBars,
  renderReportDashboard,
  REPORT_COLORS,
} from './report-charts.js';
