import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 几何无衬线字体(Inter 可变字重),离线本地打包
import "@fontsource-variable/inter";

import "./ui/theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
