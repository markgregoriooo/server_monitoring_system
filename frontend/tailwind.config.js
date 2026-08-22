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
        // ⚠️ `font-mono` here is Share Tech Mono, NOT the JetBrains Mono that
        // index.css sets on html/body. Two monospace families in one app is an
        // accident rather than a decision — see the note in index.css.
        mono: ["Share Tech Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
