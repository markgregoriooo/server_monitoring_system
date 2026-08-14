import {
  Chart,
  LineElement, PointElement, LineController,
  BarElement, BarController,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler, registerables
} from "chart.js";
// chartjs-plugin-zoom (and its hammerjs peer for pinch) were registered here for the
// Environment page's scroll-to-zoom / drag-to-select. Both are gone — the range picker is
// the one way to change the window now — so the plugin is unregistered and uninstalled
// rather than left shipping in the bundle for nothing.
Chart.register(
  LineElement, PointElement, LineController,
  BarElement, BarController,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler, ...registerables
);

export default Chart;