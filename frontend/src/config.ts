// Backend base URL for the Axios client (api/client.ts) and Socket.IO (socket/socket.ts).
//
// Order:
//   1. VITE_API_URL (frontend/.env): explicit override. Use for production/HTTPS, or
//      when the backend is on another host.
//   2. Otherwise the page's own host on port 3000. Follows whatever address the
//      dashboard was opened from, so changing networks needs no edits.
const override = import.meta.env.VITE_API_URL?.trim();

export const API_URL =
  override && override.length > 0
    ? override.replace(/\/+$/, "")
    : `${window.location.protocol}//${window.location.hostname}:3000`;
