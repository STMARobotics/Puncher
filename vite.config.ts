import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  plugins: [react()],
  root: resolve(projectRoot, "ui"),
  build: { outDir: resolve(projectRoot, "dist/ui"), emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/config.json": "http://127.0.0.1:3000",
    },
  },
});
