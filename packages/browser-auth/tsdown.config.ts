import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/protocol.ts",
    "src/tracing.ts",
    "src/cli/main.ts",
  ],
  format: "esm",
  platform: "node",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  dts: true,
  clean: true,
});
