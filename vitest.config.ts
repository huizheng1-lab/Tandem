import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/tmp/**"],
    fileParallelism: false,
    setupFiles: ["tests/setup.ts"]
  }
});
