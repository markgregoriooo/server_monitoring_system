import { io } from "socket.io-client";

// auth callback is evaluated on every (re)connect, so it picks up
// the token that was written to sessionStorage after login
export const socket = io("http://192.168.100.9:3000", {
  autoConnect: false,
  auth: (cb) => {
    try {
      const raw = sessionStorage.getItem("cspc_token");
      cb({ token: raw ? JSON.parse(raw) : undefined });
    } catch {
      cb({ token: undefined });
    }
  },
});
