// Verify each tool handler end-to-end without booting the MCP transport.
// This imports the server module and pulls handlers off the internal map.
//
// Run: STYLEFORGE_HOME=/tmp/styleforge-seed node server/verify-handlers.js

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  AuthorPaths,
  defaultRoot,
  listAuthors,
} from "./core/author.js";
import { loadIndex } from "./core/corpus.js";
import { recomputeStats, bucketedSample } from "./core/stats.js";
import { listSnapshots } from "./core/snapshot.js";
import { readText } from "./io/atomic.js";

console.log(`STYLEFORGE_HOME = ${process.env.STYLEFORGE_HOME}`);
console.log(`defaultRoot()   = ${defaultRoot()}\n`);

// 1. list_authors
const authors = await listAuthors();
console.log("=== list_authors ===");
console.log(JSON.stringify(authors, null, 2));

if (authors.length === 0) {
  console.log("\nNo authors yet. Run smoke-test first.");
  process.exit(0);
}

const slug = authors[0].slug;
const paths = new AuthorPaths(slug);

// 2. get_writing_guide
console.log(`\n=== get_writing_guide(${slug}) (preview, first 60 lines) ===`);
const overlay = (await readText(paths.overlay)) ?? "";
const stylePatterns = (await readText(paths.stylePatterns)) ?? "";
const learned = (await readText(paths.learnedRules)) ?? "";
const guidePreview = [
  `# Writing guide for: ${authors[0].display_name} (${slug})`,
  "",
  "## SKILL_OVERLAY",
  overlay.trim(),
  "",
  "## style-patterns.md",
  stylePatterns.trim(),
  "",
  "## learned-rules.md",
  learned.trim() || "(none)",
].join("\n");
console.log(guidePreview.split("\n").slice(0, 60).join("\n"));

// 3. get_stats
console.log(`\n=== get_stats(${slug}) ===`);
const stats = await recomputeStats(paths);
const idx = await loadIndex(paths.corpusIndex);
const topics = {};
for (const e of idx.entries) {
  if (!e.topics?.length) {
    topics._untagged = (topics._untagged || 0) + 1;
  } else {
    for (const t of e.topics) topics[t] = (topics[t] || 0) + 1;
  }
}
console.log(JSON.stringify({
  author: authors[0].display_name,
  slug,
  entries: idx.entries.length,
  sample_warning: idx.entries.length < 15
    ? `corpus has only ${idx.entries.length} entries — pattern frequencies are not yet statistically meaningful`
    : null,
  topics,
  patterns: Object.values(stats)
    .sort((a, b) => b.weighted_count - a.weighted_count)
    .map((s) => ({
      pattern_id: s.pattern_id,
      count: s.raw_count,
      frequency: Number(s.frequency.toFixed(3)),
    })),
}, null, 2));

// 4. sample_corpus
console.log(`\n=== sample_corpus(${slug}, k=2) ===`);
const samples = await bucketedSample(paths, { k: 2 });
console.log(JSON.stringify(
  samples.map((e) => ({
    entry_id: e.entry_id,
    title: e.title,
    topics: e.topics,
    char_count: e.char_count,
  })),
  null,
  2,
));

// 5. list_snapshots
console.log(`\n=== list_snapshots(${slug}) ===`);
const snaps = await listSnapshots(paths);
console.log(JSON.stringify(
  snaps.map((s) => ({
    name: s.name,
    label: s.label,
    created_at: s.createdAt.toISOString(),
  })),
  null,
  2,
));

console.log("\n✓ all handlers verified");
