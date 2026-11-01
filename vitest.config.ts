import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The mock Graph API and the webhook server listen on ports 4750-4769 only.
    // Two workers keep the suite light on a busy machine and keep port contention low.
    maxWorkers: 2,
    testTimeout: 20_000,
  },
});
