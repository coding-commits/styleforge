// End-to-end smoke test for styleforge core modules.
// Exercises every code path that the MCP tool handlers would hit, but
// without depending on the MCP SDK (which isn't installed in this sandbox).
//
// Run: STYLEFORGE_HOME=/tmp/styleforge-test node server/smoke-test.js

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  AuthorPaths,
  createAuthor,
  defaultRoot,
  deleteAuthor,
  getAuthor,
  isValidSlug,
  listAuthors,
} from "./core/author.js";
import { logAction } from "./core/changelog.js";
import { loadIndex, saveIndex } from "./core/corpus.js";
import {
  fingerprintText,
  hamming,
  sha256OfText,
  simhash,
} from "./core/dedupe.js";
import { executeIngest, planIngest } from "./core/ingest.js";
import {
  createSnapshot,
  listSnapshots,
  rollbackTo,
} from "./core/snapshot.js";
import { bucketedSample, recomputeStats } from "./core/stats.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}  ${detail}`);
    fail++;
  }
}

async function setupCleanRoot() {
  const root = process.env.STYLEFORGE_HOME;
  if (!root) throw new Error("set STYLEFORGE_HOME for tests");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "authors"), { recursive: true });
  return root;
}

async function testDedupe() {
  console.log("\n[dedupe]");
  check("sha256 stable", sha256OfText("abc") === sha256OfText("abc"));
  check("sha256 distinguishes",  sha256OfText("abc") !== sha256OfText("abd"));
  check("simhash stable", simhash("白日依山尽") === simhash("白日依山尽"));

  // ~2% noise
  let chars = ("海边的西塞罗写作风格的核心是从小切口进入大主题。".repeat(200)).split("");
  for (let i = 0; i < Math.floor(chars.length / 50); i++) {
    chars[Math.floor(Math.random() * chars.length)] = "※";
  }
  const a = "海边的西塞罗写作风格的核心是从小切口进入大主题。".repeat(200);
  const b = chars.join("");
  const dNear = hamming(simhash(a), simhash(b));
  check(`simhash near-dup hamming reasonable (got ${dNear})`, dNear <= 8);

  const c = "段落内容。".repeat(500);
  const dApp = hamming(simhash(c), simhash(c + "结尾再加一句。"));
  check(`simhash appended-sentence hamming small (got ${dApp})`, dApp <= 2);

  const d1 = "白日依山尽,黄河入海流。".repeat(50);
  const d2 = "云想衣裳花想容,春风拂槛露华浓。".repeat(50);
  const dFar = hamming(simhash(d1), simhash(d2));
  check(`simhash unrelated hamming large (got ${dFar})`, dFar >= 10);

  const fp = fingerprintText("段落内容。".repeat(500));
  check("fingerprint returns sha + simhashes", fp.sha.length === 64 && fp.simhashes.length >= 1);
}

async function testAuthorLifecycle(root) {
  console.log("\n[author lifecycle]");
  const before = await listAuthors();
  check("starts empty", before.length === 0);

  const meta = await createAuthor({ slug: "hbdxsl", displayName: "海边的西塞罗", description: "测试作者" });
  check("create returns meta with slug", meta.slug === "hbdxsl");

  const list = await listAuthors();
  check("list shows new author", list.length === 1 && list[0].slug === "hbdxsl");

  const got = await getAuthor("hbdxsl");
  check("get returns meta", got && got.display_name === "海边的西塞罗");

  // Slug validation
  let threw = false;
  try { await createAuthor({ slug: "Bad Slug!", displayName: "X" }); }
  catch (e) { threw = true; }
  check("rejects invalid slug", threw);

  // Duplicate
  let dup = false;
  try { await createAuthor({ slug: "hbdxsl", displayName: "X" }); }
  catch (e) { dup = e.code === "EEXIST"; }
  check("rejects duplicate slug", dup);

  // Files exist
  const paths = new AuthorPaths("hbdxsl");
  const styleExists = await fs.stat(paths.stylePatterns).then(() => true).catch(() => false);
  const overlayExists = await fs.stat(paths.overlay).then(() => true).catch(() => false);
  const indexExists = await fs.stat(paths.corpusIndex).then(() => true).catch(() => false);
  check("style-patterns.md created", styleExists);
  check("SKILL_OVERLAY.md created", overlayExists);
  check("corpus-index.json created", indexExists);
}

async function testIngestFlow(root) {
  console.log("\n[ingest flow]");
  const paths = new AuthorPaths("hbdxsl");

  const seedDir = path.resolve("../styleforge-mcp/corpus_seed");
  const seedFiles = (await fs.readdir(seedDir)).filter((n) => n.endsWith(".txt"));
  const fullPaths = seedFiles.map((n) => path.join(seedDir, n));

  // Dry run
  const plan = await planIngest(paths, fullPaths);
  check("dry-run finds 3 new files", plan.new_files.length === 3);
  check("no false dupes", plan.exact_duplicates.length === 0 && plan.near_duplicates.length === 0);

  // Execute
  const result = await executeIngest(paths, plan);
  check("execute reports 3 ingested", result.ingested.length === 3);
  check("snapshot was taken", result.snapshot && result.snapshot.length > 0);

  // Re-ingest = exact dups
  const plan2 = await planIngest(paths, fullPaths);
  check("re-ingest finds 3 exact dups", plan2.exact_duplicates.length === 3);
  check("re-ingest finds 0 new", plan2.new_files.length === 0);

  // Within-batch duplicate (same fresh file twice in one call, before it's in corpus)
  const batchTest1 = path.join(os.tmpdir(), `batch-test-${Date.now()}.txt`);
  await fs.writeFile(batchTest1, "全新的批次测试内容,本来不在 corpus 里。", "utf-8");
  const planBatch = await planIngest(paths, [batchTest1, batchTest1]);
  // First copy is new; second copy is a within-batch duplicate (matched_id starts with <batch>)
  const batchDups = planBatch.exact_duplicates.filter((m) => m.matched_id.startsWith("<batch>"));
  check("within-batch duplicate detected", batchDups.length === 1);
  await fs.unlink(batchTest1).catch(() => {});

  // Index inspection
  const index = await loadIndex(paths.corpusIndex);
  check("index has 3 entries", index.entries.length === 3);
  check("simhashes serialized as strings", typeof index.entries[0].simhashes[0] === "string");

  return result.snapshot;
}

async function testEnrichmentAndStats() {
  console.log("\n[enrichment + stats]");
  const paths = new AuthorPaths("hbdxsl");
  const index = await loadIndex(paths.corpusIndex);

  // Manually enrich (in production this is record_pattern_evidence)
  const enrichment = {
    "2026-02-03-taipingnian": {
      topics: ["history", "tang-song"],
      pattern_ids: ["struct.cut-in.cultural-artifact", "struct.history-hook", "struct.mainstream-then-reversal", "synt.em-dash-amplification"],
    },
    "2026-02-04-fengdao": {
      topics: ["history", "five-dynasties"],
      pattern_ids: ["struct.cut-in.cultural-artifact", "struct.history-hook", "rhet.exegesis-via-allusion"],
    },
    "2026-02-05-epstein": {
      topics: ["current-affairs", "us-society"],
      pattern_ids: ["struct.cut-in.cultural-artifact", "struct.history-hook", "rhet.modern-quote", "synt.em-dash-amplification"],
    },
  };
  for (const e of index.entries) {
    if (enrichment[e.entry_id]) {
      e.topics = enrichment[e.entry_id].topics;
      e.pattern_ids = enrichment[e.entry_id].pattern_ids;
    }
  }
  await saveIndex(paths.corpusIndex, index);

  const stats = await recomputeStats(paths);
  check("recompute returns patterns", Object.keys(stats).length > 0);
  check("100% pattern at 3/3", stats["struct.cut-in.cultural-artifact"]?.raw_count === 3);
  check("33% pattern at 1/3", stats["rhet.modern-quote"]?.raw_count === 1);
  check("freq normalized", Math.abs(stats["struct.cut-in.cultural-artifact"].frequency - 1.0) < 0.001);

  // Bucketed sampling
  const samples = await bucketedSample(paths, { k: 2 });
  check("sampling returns 2", samples.length === 2);
  const histSamples = await bucketedSample(paths, { topic: "history", k: 2 });
  check("topic sampling prefers history", histSamples[0].topics.includes("history"));
}

async function testSnapshotRollback(initialSnapshot) {
  console.log("\n[snapshot + rollback]");
  const paths = new AuthorPaths("hbdxsl");

  const before = await listSnapshots(paths);
  check("at least one snapshot exists", before.length >= 1);

  // Make a change: add a "garbage" entry by ingesting a junk file
  const junkPath = path.join(os.tmpdir(), `junk-${Date.now()}.txt`);
  await fs.writeFile(junkPath, "完全不相关的测试内容。", "utf-8");
  const plan = await planIngest(paths, [junkPath]);
  await executeIngest(paths, plan);

  const indexAfterJunk = await loadIndex(paths.corpusIndex);
  check("after junk ingest, 4 entries", indexAfterJunk.entries.length === 4);

  // Find the snapshot taken before this junk ingest (latest "pre-ingest-1files")
  const snaps = await listSnapshots(paths);
  const preJunk = [...snaps].reverse().find((s) => s.label && s.label.startsWith("pre-ingest-1"));
  check("pre-junk snapshot found", !!preJunk);

  // Rollback
  const preRollback = await rollbackTo(paths, preJunk.name);
  check("rollback creates new snapshot", preRollback.label.startsWith("pre-rollback"));

  const indexAfterRollback = await loadIndex(paths.corpusIndex);
  check("after rollback, 3 entries", indexAfterRollback.entries.length === 3);

  // Cleanup
  await fs.unlink(junkPath).catch(() => {});
}

async function testDeleteAuthor() {
  console.log("\n[delete author]");
  await deleteAuthor("hbdxsl");
  const list = await listAuthors();
  check("after delete, list empty", list.length === 0);

  let threw = false;
  try { await deleteAuthor("hbdxsl"); } catch (e) { threw = e.code === "ENOENT"; }
  check("deleting non-existent throws", threw);
}

(async () => {
  console.log(`STYLEFORGE_HOME = ${process.env.STYLEFORGE_HOME}`);
  console.log(`defaultRoot()   = ${defaultRoot()}`);
  await setupCleanRoot();

  await testDedupe();
  await testAuthorLifecycle();
  const snap = await testIngestFlow();
  await testEnrichmentAndStats();
  await testSnapshotRollback(snap);
  await testDeleteAuthor();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
