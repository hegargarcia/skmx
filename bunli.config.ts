import { defineConfig } from "@bunli/core";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  name: "skill-sync",
  version: pkg.version,
  description: "Keeps a Claude skills directory in sync with a git repo",
  commands: { entry: "src/index.ts" },
  build: { entry: "src/index.ts", outdir: "dist" },
  // `bunli test` passes this to `bun test` as a filter, which matches on path, not glob.
  test: { pattern: ["test"] },
});
