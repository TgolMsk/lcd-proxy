import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 字体本地打包:清晰等宽正文 + 七段数码管数字(离线可用,不走 CDN)
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "dseg/css/dseg.css";

import "./ui/theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
