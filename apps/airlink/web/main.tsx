import "./styles.css";

import { Notification } from "@memo-air/react/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Notification.Area>
        <App />
      </Notification.Area>
    </StrictMode>
  );
}
