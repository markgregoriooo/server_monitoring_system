import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App";
import { ThemeProvider } from "./context/ThemeContext";
import "./index.css";

// Google OAuth client ID (public). Set VITE_GOOGLE_CLIENT_ID in frontend/.env.
// Vite inlines VITE_* at BUILD time, so a missing value can't be fixed at runtime:
// it reaches GoogleOAuthProvider as undefined and the CSPC Mail button fails with
// an error that says nothing about the real cause. Say the real cause here.
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

if (!GOOGLE_CLIENT_ID) {
  console.error(
    "[CONFIG] VITE_GOOGLE_CLIENT_ID is not set — sign-in will not work.\n" +
      "[CONFIG] Add it to frontend/.env (same client ID as the backend's " +
      "GOOGLE_CLIENT_ID) and restart the dev server; Vite only reads VITE_* at startup.",
  );
}

const root = document.getElementById("root") as HTMLElement;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <BrowserRouter>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </GoogleOAuthProvider>
  </React.StrictMode>
);
