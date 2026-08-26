import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import "./styles/theme.css";
import "./styles/app.css";

// Vercel Web Analytics is mounted inside <App/> (client/src/App.tsx's DemoAnalytics), gated to the
// public demo host — a self-hosted governance install holds private data and must not beacon to a
// third party, and off-Vercel the insights script 404s to the SPA fallback anyway.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
