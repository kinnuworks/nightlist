import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In static replay mode the exported JSON in replay-data/ is copied into the build as
// replay/...; the normal build serves nothing extra because the API server answers /api.
const isStatic = process.env.VITE_STATIC === "1";

export default defineConfig({
  plugins: [react()],
  publicDir: isStatic ? "replay-data" : "public",
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8790" },
  },
});
