// Lists the app's screens by how much copy they still carry inline rather
// than through `t()` (src/i18n) -- JSX text and quoted props a person
// reads -- most first. A rough count, for working through extraction.
//   node scripts/i18n-report.mjs [--limit 20]
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../src");
const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || 30;
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".tsx")) files.push(full);
  }
};
walk(root);

// Text between tags that reads as words, and the props people read.
const JSX_TEXT = />\s*([A-Z][A-Za-z'’,.!? -]{2,})\s*[<{]/g;
const PROPS = /\b(?:label|title|subtitle|placeholder|detail|prompt|note|aria-label)="([^"]*[A-Za-z]{2,}[^"]*)"/g;
const rows = files
  .map((file) => {
    const source = readFileSync(file, "utf8");
    return { file: path.relative(root, file), count: [...source.matchAll(JSX_TEXT)].length + [...source.matchAll(PROPS)].length };
  })
  .filter((r) => r.count > 0)
  .sort((a, b) => b.count - a.count);
const total = rows.reduce((n, r) => n + r.count, 0);
for (const r of rows.slice(0, limit)) console.log(String(r.count).padStart(5), r.file);
console.log(`\n${total} inline strings in ${rows.length} files.`);
