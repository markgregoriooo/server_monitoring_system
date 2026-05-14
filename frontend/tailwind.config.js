/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
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
        "light-bg": "#f0f4f8",
        "light-surface": "#ffffff",
        "light-surface-2": "#e8eef5",
        "light-border": "#d1dbe8",
        "light-text": "#1a2535",
        "light-muted": "#64748b",
      },
      fontFamily: {
        mono: ["Share Tech Mono", "monospace"],
        body: ["Barlow", "sans-serif"],
      },
    },
  },
  plugins: [],
};
