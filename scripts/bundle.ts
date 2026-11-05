import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
await build({
  entryPoints: [
    resolve(projectRoot, "service/api.ts"),
    resolve(projectRoot, "service/auth.ts"),
    resolve(projectRoot, "service/cleanup.ts"),
    resolve(projectRoot, "service/shop-totals.ts"),
  ],
  outdir: resolve(projectRoot, "dist/service"),
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  packages: "external",
  sourcemap: true,
});
