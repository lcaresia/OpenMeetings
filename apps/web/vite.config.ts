import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the panel runs on Vite and talks to `om serve` on its default port.
const server = process.env.OM_SERVER ?? "http://127.0.0.1:4319";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": server, "/agui": server, "/v1": server },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
