import { build } from "esbuild";
await build({
  entryPoints: [
    "service/api.ts",
    "service/auth.ts",
    "service/cleanup.ts",
    "service/shop-totals.ts",
  ],
  outdir: "dist/service",
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  packages: "external",
  sourcemap: true,
});
