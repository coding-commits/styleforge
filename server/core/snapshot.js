// Snapshots and rollback.
//
// Snapshots are timestamped directories under <author>/snapshots/. Each one
// copies the small mutable-state files (corpus-index.json, style-patterns.md,
// observations.md, learned-rules.md, SKILL_OVERLAY.md). The corpus/ directory
// is NOT snapshotted — corpus files are append-only-by-convention and copying
// them on every snapshot would balloon disk use. The index records sha256 of
// every entry so corpus integrity can still be verified.
//
// Rollback restores snapshotted files and creates a new snapshot of the
// pre-rollback state, so "rollback the rollback" always works.

import { promises as fs } from "node:fs";
import path from "node:path";

// Files included in every snapshot.
export const SNAPSHOT_FILES = [
  "corpus-index.json",
  "style-patterns.md",
  "observations.md",
  "SKILL_OVERLAY.md",
  "feedback/learned-rules.md",
];

// 2026-04-26T14-30-00 — filesystem-safe (no colons).
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/;

function nowStamp() {
  // Use UTC, replace : with -, drop fractional and Z.
  const d = new Date();
  return d.toISOString().slice(0, 19).replace(/:/g, "-");
}

function parseStamp(name) {
  if (!TIMESTAMP_RE.test(name)) return null;
  // Match the canonical 19-char form first, with optional counter suffix.
  // "2026-04-26T14-30-00" or "2026-04-26T14-30-00-1"
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

async function copyFileIfExists(src, dst) {
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

export async function listSnapshots(paths) {
  let children;
  try {
    children = await fs.readdir(paths.snapshotsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const ts = parseStamp(child.name);
    if (!ts) continue;
    const snapPath = path.join(paths.snapshotsDir, child.name);
    let label = "";
    try {
      label = (await fs.readFile(path.join(snapPath, "LABEL.txt"), "utf-8")).trim();
    } catch {}
    out.push({ name: child.name, path: snapPath, createdAt: ts, label });
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export async function createSnapshot(paths, { label = "" } = {}) {
  let name = nowStamp();
  let target = path.join(paths.snapshotsDir, name);
  let counter = 1;
  while (true) {
    try {
      await fs.mkdir(target, { recursive: false });
      break;
    } catch (err) {
      if (err.code === "EEXIST") {
        target = path.join(paths.snapshotsDir, `${name}-${counter}`);
        counter++;
        continue;
      }
      throw err;
    }
  }
  // Refresh actual snapshot name (might have a counter suffix).
  const actualName = path.basename(target);

  for (const rel of SNAPSHOT_FILES) {
    const src = path.join(paths.base, rel);
    const dst = path.join(target, rel);
    await copyFileIfExists(src, dst);
  }
  if (label) {
    await fs.writeFile(path.join(target, "LABEL.txt"), label, "utf-8");
  }
  return { name: actualName, path: target, label, createdAt: parseStamp(actualName) || new Date() };
}

export async function getSnapshot(paths, name) {
  const target = path.join(paths.snapshotsDir, name);
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  let label = "";
  try {
    label = (await fs.readFile(path.join(target, "LABEL.txt"), "utf-8")).trim();
  } catch {}
  return { name, path: target, label, createdAt: parseStamp(name) || new Date() };
}

/**
 * Restore files from snapshot `name`. Before restoring, takes a fresh snapshot
 * of the current state (so the rollback itself can be undone). Returns the
 * pre-rollback snapshot record.
 */
export async function rollbackTo(paths, name, { only } = {}) {
  const snap = await getSnapshot(paths, name);
  if (!snap) {
    const err = new Error(`snapshot ${JSON.stringify(name)} not found`);
    err.code = "ENOENT";
    throw err;
  }
  const preRollback = await createSnapshot(paths, { label: `pre-rollback-to-${name}` });

  const targets = Array.isArray(only) && only.length > 0 ? only : SNAPSHOT_FILES;
  for (const rel of targets) {
    const src = path.join(snap.path, rel);
    const dst = path.join(paths.base, rel);
    const copied = await copyFileIfExists(src, dst);
    if (!copied) {
      // File didn't exist at snapshot time — remove the current one so we
      // faithfully restore that state.
      try { await fs.unlink(dst); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  }
  return preRollback;
}

/**
 * Apply the retention policy:
 * - keep all snapshots from the last 7 days
 * - keep one per ISO week for the prior 12 weeks
 * - keep one per calendar month for the prior 12 months
 * - delete the rest
 */
export async function pruneSnapshots(paths, { dryRun = false } = {}) {
  const snaps = await listSnapshots(paths);
  if (snaps.length === 0) return [];

  const now = new Date();
  const keep = new Set();
  const weeklySeen = new Set();
  const monthlySeen = new Set();

  // Walk newest first.
  const sorted = [...snaps].sort((a, b) => b.createdAt - a.createdAt);
  for (const s of sorted) {
    const ageDays = (now - s.createdAt) / (1000 * 60 * 60 * 24);
    if (ageDays <= 7) {
      keep.add(s.name);
      continue;
    }
    if (ageDays <= 7 + 12 * 7) {
      // ISO week key
      const wk = isoWeekKey(s.createdAt);
      if (!weeklySeen.has(wk)) {
        keep.add(s.name);
        weeklySeen.add(wk);
      }
      continue;
    }
    if (ageDays <= 7 + 12 * 7 + 12 * 30) {
      const mk = `${s.createdAt.getUTCFullYear()}-${s.createdAt.getUTCMonth()}`;
      if (!monthlySeen.has(mk)) {
        keep.add(s.name);
        monthlySeen.add(mk);
      }
      continue;
    }
  }

  const deleted = [];
  for (const s of snaps) {
    if (keep.has(s.name)) continue;
    deleted.push(s);
    if (!dryRun) {
      await fs.rm(s.path, { recursive: true, force: true });
    }
  }
  return deleted;
}

function isoWeekKey(date) {
  // Approximate ISO week: not as rigorous as Python's isocalendar but close
  // enough for snapshot grouping.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-${weekNum}`;
}
