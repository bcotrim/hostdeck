import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const files = [
  ["index.html", "index.html"],
  ["src/main.js", "src/main.js"],
  ["src/styles.css", "src/styles.css"],
  ["src/lib/hosts.js", "src/lib/hosts.js"]
];

await rm(dist, { recursive: true, force: true });

for (const [source, target] of files) {
  const destination = join(dist, target);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(root, source), destination);
}
