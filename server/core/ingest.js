// Ingest pipeline: deterministic part only.
//
// The semantic part (extracting style highlights, tagging topics, upgrading
// observations to rules) is left to the agent — we expose record_pattern_evidence
// for that.

import { promises as fs } from "node:fs";
import path from "node:path";

import { logAction } from "./changelog.js";
import { loadIndex, saveIndex, deriveEntryId, nowIso } from "./corpus.js";
import {
  fingerprintText,
  findDuplicates,
  simhashesFromJson,
  simhashesToJson,
} from "./dedupe.js";
import { createSnapshot } from "./snapshot.js";

async function readSourceText(filePath) {
  // Try utf-8; fall back to lossy decode if needed.
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (err.code !== "ERR_INVALID_CHAR_ENCODING") throw err;
    const buf = await fs.readFile(filePath);
    return buf.toString("utf-8"); // best-effort
  }
}

function buildCorpusFingerprints(index, paths) {
  return index.entries.map((e) => ({
    entryId: e.entry_id,
    path: path.join(paths.base, e.source_path),
    sha256: e.sha256,
    simhashes: simhashesFromJson(e.simhashes),
  }));
}

/**
 * Inspect files, produce a plan. No side effects.
 *
 * @param {AuthorPaths} paths
 * @param {string[]} files - absolute paths
 * @param {object} opts
 */
export async function planIngest(paths, files, { hammingThreshold = 6 } = {}) {
  const plan = {
    new_files: [],
    exact_duplicates: [],
    near_duplicates: [],
    errors: [],
  };

  const index = await loadIndex(paths.corpusIndex);
  const fps = buildCorpusFingerprints(index, paths);
  const seenInBatch = new Map(); // sha -> first path in batch

  for (const f of files) {
    let stat;
    try {
      stat = await fs.stat(f);
    } catch {
      plan.errors.push({ path: f, reason: "file not found" });
      continue;
    }
    if (!stat.isFile()) {
      plan.errors.push({ path: f, reason: "not a regular file" });
      continue;
    }
    let text;
    try {
      text = await readSourceText(f);
    } catch (err) {
      plan.errors.push({ path: f, reason: `read error: ${err.message}` });
      continue;
    }

    const { sha: candSha } = fingerprintText(text);

    // Within-batch dup check.
    if (seenInBatch.has(candSha)) {
      const prior = seenInBatch.get(candSha);
      plan.exact_duplicates.push({
        candidate: f,
        matched_id: `<batch>${path.basename(prior)}`,
        matched_path: prior,
        kind: "exact",
        distance: 0,
      });
      continue;
    }

    const matches = findDuplicates(f, text, fps, { hammingThreshold });
    const exact = matches.filter((m) => m.kind === "exact");
    if (exact.length > 0) {
      for (const m of exact) {
        plan.exact_duplicates.push({
          candidate: m.candidatePath,
          matched_id: m.matchedId,
          matched_path: m.matchedPath,
          kind: m.kind,
          distance: m.distance,
        });
      }
      continue;
    }
    const near = matches.filter((m) => m.kind === "near");
    if (near.length > 0) {
      for (const m of near) {
        plan.near_duplicates.push({
          candidate: m.candidatePath,
          matched_id: m.matchedId,
          matched_path: m.matchedPath,
          kind: m.kind,
          distance: m.distance,
        });
      }
      continue; // near-dup needs user judgement — don't auto-add to new_files
    }

    seenInBatch.set(candSha, f);
    plan.new_files.push(f);
  }

  return plan;
}

/**
 * Execute the plan. Each new file is copied into corpus/, indexed,
 * and a snapshot is taken before any change.
 */
export async function executeIngest(paths, plan, { weight = 1.0, takeSnapshot = true, allowNear = false } = {}) {
  const result = { plan, ingested: [], snapshot: null };

  // If allow_near, promote near_duplicates to new_files.
  if (allowNear) {
    for (const m of plan.near_duplicates) {
      if (!plan.new_files.includes(m.candidate)) {
        plan.new_files.push(m.candidate);
      }
    }
  }

  if (plan.new_files.length === 0) {
    await logAction(paths, "ingest", {
      details: {
        ingested: [],
        exact_duplicates: plan.exact_duplicates.map((m) => m.candidate),
        near_duplicates: plan.near_duplicates.map((m) => m.candidate),
        errors: plan.errors.map((e) => e.path),
      },
    });
    return result;
  }

  if (takeSnapshot) {
    const snap = await createSnapshot(paths, { label: `pre-ingest-${plan.new_files.length}files` });
    result.snapshot = snap.name;
  }

  const index = await loadIndex(paths.corpusIndex);
  await fs.mkdir(paths.corpusDir, { recursive: true });

  for (const src of plan.new_files) {
    const text = await readSourceText(src);
    const { sha, simhashes } = fingerprintText(text);

    // Title: first non-empty line, after stripping any "标题:" prefix.
    let title = "";
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      title = t.startsWith("标题:") ? t.slice("标题:".length).trim() : t;
      break;
    }

    // Copy source into corpus/.
    const baseName = path.basename(src);
    let dest = path.join(paths.corpusDir, baseName);
    let i = 2;
    while (true) {
      try {
        await fs.access(dest);
        // exists -> disambiguate
        const parsed = path.parse(baseName);
        dest = path.join(paths.corpusDir, `${parsed.name}-${i}${parsed.ext}`);
        i++;
      } catch {
        break;
      }
    }
    await fs.copyFile(src, dest);

    const entry = {
      entry_id: deriveEntryId(path.basename(dest)),
      title: title || path.parse(dest).name,
      source_path: path.relative(paths.base, dest).split(path.sep).join("/"),
      char_count: text.length,
      sha256: sha,
      simhashes: simhashesToJson(simhashes),
      topics: [],
      pattern_ids: [],
      weight,
      ingested_at: nowIso(),
      notes: "",
    };
    index.entries.push(entry);
    result.ingested.push(entry);
  }

  await saveIndex(paths.corpusIndex, index);

  await logAction(paths, "ingest", {
    snapshot: result.snapshot,
    details: {
      ingested: result.ingested.map((e) => e.entry_id),
      weight,
      exact_duplicates: plan.exact_duplicates.map((m) => m.candidate),
      near_duplicates: plan.near_duplicates.map((m) => m.candidate),
      errors: plan.errors.map((e) => e.path),
    },
  });

  return result;
}
