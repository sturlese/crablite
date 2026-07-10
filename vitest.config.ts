import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests set process.env per-test; don't let one file's env leak into another.
    isolate: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        // Entry point + thin I/O / timer-scheduler adapters that need real
        // sockets/TTY/hardware and carry no branching logic worth unit-testing.
        "src/index.ts",
        "src/channels/whatsapp.ts",
        "src/channels/cli.ts",
        "src/dreaming-cron.ts",
        "src/heartbeat.ts",
        "src/logger.ts",
        "**/*.test.ts",
      ],
      reporter: ["text-summary", "text"],
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 75,
        branches: 65,
      },
    },
  },
});
