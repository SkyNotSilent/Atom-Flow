import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { captureGlobalError } from "./utils/logger";

window.onerror = (message, source, lineno, colno, error) => {
  captureGlobalError("Unhandled window error", error, { message: String(message), source, lineno, colno });
};

window.onunhandledrejection = (event) => {
  captureGlobalError("Unhandled promise rejection", event.reason);
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
