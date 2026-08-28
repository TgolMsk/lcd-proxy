import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发约定:固定端口 1420,供 tauri.conf.json 的 devUrl 使用
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "chrome105",
    outDir: "dist",
  },
});
