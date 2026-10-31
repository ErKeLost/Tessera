import { copyFile } from "node:fs/promises";
import { join } from "node:path";

if (process.env.NITRO_PRESET === "netlify") {
  const root = process.cwd();
  await copyFile(join(root, "node_modules", ".nitro", "vite", "index.html"), join(root, "dist", "index.html"));
}
