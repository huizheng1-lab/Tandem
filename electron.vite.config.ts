import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "app/main/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "app/preload/index.ts")
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "app/renderer"),
    build: {
      rollupOptions: {
        input: resolve(__dirname, "app/renderer/index.html")
      }
    }
  }
});
