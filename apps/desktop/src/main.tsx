import React from "react";
import ReactDOM from "react-dom/client";
import { HeroUIProvider } from "@heroui/react";
import App from "./App";
import "./index.css";

const media = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
}
applyTheme(media.matches);
media.addEventListener("change", (event) => applyTheme(event.matches));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HeroUIProvider>
      <App />
    </HeroUIProvider>
  </React.StrictMode>,
);
