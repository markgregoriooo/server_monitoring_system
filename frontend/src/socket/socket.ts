import { io } from "socket.io-client";
import { API_URL } from "../config";

// auth callback is evaluated on every (re)connect, so it picks up
// the token that was written to sessionStorage after login
export const socket = io(API_URL, {
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
