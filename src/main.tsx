import React from "react";
import { createRoot } from "react-dom/client";

import "antd/dist/reset.css";
import App from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("未找到 root 挂载点");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
