// Corpus index: structured record of every ingested document.
// JSON is machine-friendly; we keep it separate from style-patterns.md
// (which is human/agent-friendly markdown).

import path from "node:path";
import { readJson, writeJsonAtomic } from "../io/atomic.js";

/**
 * Entry shape (kept as plain object for JSON ergonomics):
 * {
 *   entry_id: string,
 *   title: string,
 *   source_path: string,        // path inside <author_base>, e.g. "corpus/foo.txt"
 *   char_count: number,
 *   sha256: string,             // hex
 *   simhashes: string[],        // BigInt encoded as decimal strings
 *   topics: string[],
 *   pattern_ids: string[],
 *   signature_passages: string[], // context-agnostic style exemplars (≤120 chars each)
 *   weight: number,
 *   ingested_at: string,        // ISO
 *   notes: string
 * }
 */

export async function loadIndex(indexPath) {
  const data = await readJson(indexPath);
  if (!data) {
    return { version: 1, entries: [], patterns_evidence: {} };
  }
  // Backfill missing fields for forward compatibility.
  data.version ??= 1;
  data.entries ??= [];
  data.patterns_evidence ??= {};
  return data;
}

export async function saveIndex(indexPath, index) {
  await writeJsonAtomic(indexPath, index);
}

export function deriveEntryId(sourceFilename) {
  const stem = path.parse(sourceFilename).name;
  return stem.trim().replace(/\s+/g, "-");
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
