import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // bind to 0.0.0.0 so the dev server is reachable via the LAN IP (192.168.100.9:5173), not just localhost
  },
});
