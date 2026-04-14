/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: "#080f1e",
        surface: "#0d1728",
        "surface-2": "#111f38",
        gold: "#f5c400",
        "gold-dim": "#d4a800",
        cyan: "#00d4ff",
      },
      fontFamily: {
        mono: ["Share Tech Mono", "monospace"],
        body: ["Barlow", "sans-serif"],
      },
    },
  },
  plugins: [],
};
