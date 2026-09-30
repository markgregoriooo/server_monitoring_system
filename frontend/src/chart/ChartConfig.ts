import {
  Chart,
  LineElement, PointElement, LineController,
  BarElement, BarController,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler, registerables
} from "chart.js";
// chartjs-plugin-zoom (and hammerjs) were removed; the range picker is the only way to
// change a chart's window now.
Chart.register(
  LineElement, PointElement, LineController,
  BarElement, BarController,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler, ...registerables
);

export default Chart;