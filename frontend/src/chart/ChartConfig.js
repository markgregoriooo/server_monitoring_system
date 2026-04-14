import {
  Chart,
  LineElement, PointElement, LineController,
  BarElement, BarController,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler,
} from "chart.js";

Chart.register(
  LineElement, PointElement, LineController,
  BarElement, BarController,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler
);
