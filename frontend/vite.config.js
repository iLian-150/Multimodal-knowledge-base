import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    // Standalone deployments are served from the domain root (for example :3001).
    // Set VITE_BASE_PATH=/frontend/ when embedding the build under the API server.
    base: env.VITE_BASE_PATH || "/",
    plugins: [react()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
