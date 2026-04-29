#!/usr/bin/env node
// Sync version from package.json to all other locations.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const version = pkg.version;

function updateJson(filePath, updater) {
  const obj = JSON.parse(readFileSync(filePath, "utf-8"));
  updater(obj);
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
}

// manifest.json
updateJson(resolve(root, "manifest.json"), (obj) => {
  obj.version = version;
});

// .claude-plugin/marketplace.json
updateJson(resolve(root, ".claude-plugin/marketplace.json"), (obj) => {
  for (const plugin of obj.plugins) {
    plugin.version = version;
  }
});

// .claude-plugin/plugin.json
updateJson(resolve(root, ".claude-plugin/plugin.json"), (obj) => {
  obj.version = version;
});

// skills/styleforge/SKILL.md (frontmatter)
const skillPath = resolve(root, "skills/styleforge/SKILL.md");
const skillText = readFileSync(skillPath, "utf-8");
const updated = skillText.replace(/^(version:\s*).+$/m, `$1${version}`);
writeFileSync(skillPath, updated);

console.log(`Synced version ${version} to all files.`);
