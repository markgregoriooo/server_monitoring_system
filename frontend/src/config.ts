// Backend base URL for the Axios client (api/client.ts) and the Socket.IO
// client (socket/socket.ts). Set in ONE place here.
//
// Precedence:
//   1. VITE_API_URL (from frontend/.env) — explicit override. Use this for production
//      / HTTPS, or when the backend lives on a different host than the dashboard.
//   2. Auto-detected from the page's own host on port 3000 — recommended for LAN.
//      Because it follows window.location, the dashboard reaches the backend at whatever
//      address you opened it from (localhost OR any IP), so changing networks/IPs needs
//      NO code or .env edits.
const override = import.meta.env.VITE_API_URL?.trim();

export const API_URL =
  override && override.length > 0
    ? override.replace(/\/+$/, "")
    : `${window.location.protocol}//${window.location.hostname}:3000`;
