import React from "react";
import ReactDOM from "react-dom/client";
import { HeroUIProvider } from "@heroui/react";
import App from "./App";
import { initAudit, logAudit } from "./lib/audit";
import "./index.css";

function Root(): React.JSX.Element {
  return (
    <HeroUIProvider>
      <App />
    </HeroUIProvider>
  );
}

initAudit();
window.addEventListener("error", (event) => {
  logAudit("error.ui", { message: event.message, context: `${event.filename}:${event.lineno}` });
});
window.addEventListener("unhandledrejection", (event) => {
  logAudit("error.ui", { message: String(event.reason), context: "unhandledrejection" });
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
