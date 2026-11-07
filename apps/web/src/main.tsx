// Mounts the popover or hidden audio host; developer interfaces live outside this repository.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AudioHost } from "./AudioHost.js";
import { Popover } from "./popover/Popover.js";

const root = document.getElementById("root");
if (!root) throw new Error("The app shell is missing its root element.");
createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get("view") === "popover" ? (
      <Popover />
    ) : (
      <AudioHost />
    )}
  </StrictMode>,
);
