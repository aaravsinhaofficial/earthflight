import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

// vite-plugin-cesium handles copying Cesium's static assets (Workers, Assets,
// Widgets, ThirdParty) and setting CESIUM_BASE_URL so the engine can find them.
export default defineConfig({
  plugins: [cesium()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 4000,
  },
});
