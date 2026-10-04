import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one database.
    fileParallelism: false,
  },
});
