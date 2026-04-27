// Atomic file write helpers.
//
// Why: if a write is interrupted halfway, we don't want a half-written file
// replacing a good one. Standard pattern: write to a temp file in the same
// directory, fsync, then rename (atomic on POSIX, atomic-ish on Windows via
// MoveFileEx).

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export async function writeTextAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpName = `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  let handle;
  try {
    handle = await fs.open(tmpPath, "w");
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Cleanup tmp on failure
    try { await fs.unlink(tmpPath); } catch {}
    throw err;
  }
}

export async function writeJsonAtomic(filePath, data) {
  // sort_keys analog: deterministic ordering for diff-friendly snapshots
  const payload = JSON.stringify(data, sortedReplacer(data), 2) + "\n";
  await writeTextAtomic(filePath, payload);
}

function sortedReplacer(rootValue) {
  // Recursively sorts object keys for stable output.
  // Returns a replacer compatible with JSON.stringify.
  return function (_key, value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  };
}

export async function readJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function appendText(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(filePath, content, "utf-8");
}

export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
