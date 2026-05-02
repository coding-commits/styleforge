#!/usr/bin/env node
/**
 * styleforge MCP server
 *
 * Exposes 21 tools + 9 prompts that an agent uses to maintain per-author
 * writing-style libraries (any language):
 *
 *   - list_authors / create_author / delete_author
 *   - get_writing_guide                        (the "skill content" — fetched on demand)
 *   - sample_corpus
 *   - ingest_dryrun / ingest_execute / record_pattern_evidence / record_signature_passages
 *   - recompute_stats / get_stats
 *   - create_snapshot / list_snapshots / rollback
 *   - record_feedback / get_feedback_log / apply_learned_rule
 *   - save_draft
 *   - export_author / import_author
 *
 *   - prompts: style-write / style-ingest / style-feedback / style-export / style-import / style-help (slash-command shortcuts)
 *
 * Data location: $STYLEFORGE_HOME (set from manifest user_config.data_dir),
 * or ~/.styleforge as fallback.
 */

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  AuthorPaths,
  authorsDir,
  createAuthor,
  defaultRoot,
  deleteAuthor,
  getAuthor,
  isValidSlug,
  listAuthors,
} from "./core/author.js";
import { logAction } from "./core/changelog.js";
import { loadIndex, saveIndex } from "./core/corpus.js";
import { executeIngest, planIngest } from "./core/ingest.js";
import {
  createSnapshot,
  listSnapshots,
  rollbackTo,
} from "./core/snapshot.js";
import { bucketedSample, recomputeStats } from "./core/stats.js";
import { appendText, readText, writeTextAtomic } from "./io/atomic.js";

// ---------------------------------------------------------------------------
// Per-author write lock — serializes read-modify-write on corpus-index.json
// ---------------------------------------------------------------------------

const authorLocks = new Map();

function withAuthorLock(slug, fn) {
  const prev = authorLocks.get(slug) || Promise.resolve();
  const next = prev.then(fn, fn);
  authorLocks.set(slug, next);
  return next;
}

// ---------------------------------------------------------------------------
// Path safety helpers
//
// MCPB does NOT enforce sandboxing — server runs with full user privileges.
// We must validate every path we read to prevent traversal mischief from
// model-supplied filenames.
// ---------------------------------------------------------------------------

async function safeResolve(maybePath) {
  // Resolve the path. We allow any absolute path the user supplies (the user
  // explicitly chose to ingest those files). What we don't allow is
  // shenanigans inside the styleforge data dir from outside callers.
  return path.resolve(maybePath);
}

function ensureSlug(slug) {
  if (!isValidSlug(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)} — must be lowercase letters/digits/-/_`);
  }
}


/**
 * Re-sample examples in style-patterns.md text using observations.md.
 * Replaces each "  - 例: ..." line with a randomly picked example from
 * all observations for that pattern_id.
 */
function resampleExamples(stylePatternsText, observationsText) {
  if (!observationsText) return stylePatternsText;

  // Parse observations into Map<pattern_id, examples[]>
  const obsExamples = new Map();
  const sections = observationsText.split(/(?:^|\n)## |(?<=\S)## /).slice(1);
  for (const section of sections) {
    const lines = section.split("\n");
    const id = lines[0].trim();
    if (!id) continue;
    for (const line of lines.slice(1)) {
      const ex = line.match(/^- 例:\s*(.+)/);
      if (ex) {
        if (!obsExamples.has(id)) obsExamples.set(id, []);
        obsExamples.get(id).push(ex[1]);
      }
    }
  }

  if (obsExamples.size === 0) return stylePatternsText;

  // Replace example lines in style-patterns with freshly sampled ones
  let currentPattern = null;
  const outputLines = [];
  for (const line of stylePatternsText.split("\n")) {
    const headingMatch = line.match(/^### (.+)/);
    if (headingMatch) {
      currentPattern = headingMatch[1].trim();
    }
    const exMatch = line.match(/^(\s+- 例:\s*).+/);
    if (exMatch && currentPattern && obsExamples.has(currentPattern)) {
      const examples = obsExamples.get(currentPattern);
      const picked = examples[Math.floor(Math.random() * examples.length)];
      outputLines.push(`${exMatch[1]}${picked}`);
    } else {
      outputLines.push(line);
    }
  }
  return outputLines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_authors",
    description: "List every styleforge author registered for this user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_author",
    description: "Register a new author. Slug must be lowercase letters/digits/-/_, 2-32 chars.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Short id, e.g. 'hbdxsl'." },
        display_name: { type: "string", description: "Human-readable name." },
        description: { type: "string", description: "Optional one-liner." },
      },
      required: ["slug", "display_name"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_author",
    description: "Permanently delete an author and all their data. Irreversible. Caller must confirm with the user before invoking; this tool requires confirm=true to actually delete.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        confirm: { type: "boolean", description: "Must be true." },
      },
      required: ["slug", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "get_writing_guide",
    description: "Return the complete writing guide for an author: SKILL_OVERLAY + style-patterns + learned-rules. Call this FIRST when asked to write in an author's style.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "sample_corpus",
    description: "Return signature passages from up to 10 corpus entries, bucketed by topic. Each passage is a short context-agnostic style exemplar (≤120 chars) that demonstrates syntax/rhythm/rhetoric without leaking content. Call after get_writing_guide to calibrate voice before writing.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        topic: { type: "string", description: "Optional topic tag to prefer." },
        k: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "ingest_dryrun",
    description: "Inspect files and report what would happen on ingest. NEVER skip this step — show the result to the user before calling ingest_execute. Detects exact duplicates (sha256) and near duplicates (SimHash + Hamming).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        files: { type: "array", items: { type: "string" }, description: "Absolute paths." },
        threshold: { type: "integer", default: 6, description: "Hamming threshold for near-dup detection." },
      },
      required: ["slug", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "ingest_execute",
    description: "Actually ingest files. Creates a snapshot first. Refuses if any near-duplicates exist unless allow_near=true.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        weight: { type: "number", default: 1.0, description: ">1 means emphasize. Must be a deliberate user choice." },
        allow_near: { type: "boolean", default: false, description: "Treat near-duplicates as new files. User must have explicitly approved." },
        skip_near: { type: "boolean", default: false, description: "Drop near-duplicates entirely from the batch." },
        threshold: { type: "integer", default: 6 },
        no_snapshot: { type: "boolean", default: false, description: "Dangerous. Only set when caller has just snapshotted." },
        message: { type: "string", description: "Snapshot message describing what was ingested (e.g. 'ingest 3 articles about Song dynasty')." },
      },
      required: ["slug", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "record_pattern_evidence",
    description: "After viewing a freshly ingested article, record its topic tags and which pattern_ids it exhibits. Call once per new entry. Patterns must come from the author's existing style-patterns.md catalog; novel patterns go to observations.md instead via append_observation.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        entry_id: { type: "string", description: "Entry id from ingest result." },
        topics: { type: "array", items: { type: "string" }, default: [] },
        pattern_ids: { type: "array", items: { type: "string" }, default: [] },
      },
      required: ["slug", "entry_id"],
      additionalProperties: false,
    },
  },
  {
    name: "record_signature_passages",
    description: "Store 3-5 context-agnostic style exemplar passages for a corpus entry. Each passage (≤120 chars) is created by taking an original sentence, replacing content words with placeholders like [人物]/[事件]/[概念], keeping the syntactic skeleton and punctuation rhythm intact. This produces style templates that calibrate voice without contaminating new writing. Called during enrichment, once per entry.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        entry_id: { type: "string", description: "Entry id from ingest result." },
        passages: {
          type: "array",
          items: { type: "string", maxLength: 120 },
          minItems: 1,
          maxItems: 5,
          description: "Short passages that showcase style (syntax/rhythm/rhetoric), NOT content. Must be context-agnostic.",
        },
      },
      required: ["slug", "entry_id", "passages"],
      additionalProperties: false,
    },
  },
  {
    name: "append_observation",
    description: "Append a pattern observation to observations.md. For patterns spotted in an article that aren't yet in style-patterns.md. Once recorded and referenced in record_pattern_evidence, they appear in style-patterns.md on next recompute_stats.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        candidate_id: { type: "string", description: "Proposed short id, e.g. synt.parenthetical-aside." },
        description: { type: "string" },
        example: { type: "string", description: "Short quote (<30 chars) from the article." },
        entry_id: { type: "string", description: "Entry id where it appeared." },
      },
      required: ["slug", "candidate_id", "description", "entry_id"],
      additionalProperties: false,
    },
  },
  {
    name: "recompute_stats",
    description: "Recompute pattern frequencies from corpus-index.json. Run after a batch of record_pattern_evidence calls.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "get_stats",
    description: "Return corpus size, topic breakdown, and pattern frequencies for an author.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_snapshot",
    description: "Manually snapshot mutable state. Snapshots cover index, style-patterns, observations, overlay, learned-rules — NOT the corpus/ files (those are append-only by convention).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        label: { type: "string", description: "Optional human-readable note." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_snapshots",
    description: "List all snapshots for an author with timestamps and labels.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "rollback",
    description: "Restore an author's mutable state from a snapshot. Always saves the current state as a NEW snapshot first, so rollback-of-rollback works.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        to: { type: "string", description: "Snapshot name, e.g. 2026-04-26T14-30-00." },
        only: { type: "array", items: { type: "string" }, description: "Optional list of snapshot-relative paths to restore (omit to restore all)." },
      },
      required: ["slug", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "record_feedback",
    description: "Append one feedback entry about a recent style-write output. Granular and atomic — one call per distinct issue, even if multiple come from the same conversation.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        task: { type: "string", description: "Brief description of the original task." },
        issues: { type: "string", description: "What the user said was wrong." },
        expected: { type: "string", description: "What the user expected (if stated)." },
        output_ref: { type: "string", description: "Path or label for the offending output, if any." },
      },
      required: ["slug", "task", "issues"],
      additionalProperties: false,
    },
  },
  {
    name: "get_feedback_log",
    description: "Return the raw feedback log for an author. Used by style-feedback to digest accumulated entries.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_learned_rule",
    description: "After style-feedback negotiates a corrective rule with the user (with explicit accept), persist it to learned-rules.md. Snapshot is created automatically before append.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        rule_id: { type: "string", description: "Short id, e.g. avoid-period-pileup." },
        trigger: { type: "string", description: "When this rule applies." },
        corrective_action: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low"], default: "medium" },
        feedback_refs: { type: "array", items: { type: "string" }, description: "Identifiers of feedback entries this rule was derived from." },
      },
      required: ["slug", "rule_id", "trigger", "corrective_action"],
      additionalProperties: false,
    },
  },
  {
    name: "save_draft",
    description: "Save a style-write draft to the author's drafts/ directory as a .md file. Returns the absolute file path so the user can retrieve it. Called automatically at the end of every style-write.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        content: { type: "string", description: "The full markdown content of the draft." },
        title: { type: "string", description: "Short title for the filename (optional, defaults to timestamp)." },
      },
      required: ["slug", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "export_author",
    description: "Export one or more authors as a .tar.gz archive. Includes corpus, patterns, observations, learned-rules, and metadata. Excludes snapshots, drafts, and OS junk. Use -A (all=true) to export every author.",
    inputSchema: {
      type: "object",
      properties: {
        slugs: { type: "array", items: { type: "string" }, description: "Author slugs to export. Ignored if all=true." },
        all: { type: "boolean", default: false, description: "Export all authors." },
        output_path: { type: "string", description: "Absolute path for the output .tar.gz file. Defaults to ~/styleforge-export-<timestamp>.tar.gz." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "import_author",
    description: "Import authors from a previously exported .tar.gz archive. Use -A (all=true) to import every author in the archive, or specify slugs to import selectively. Existing authors are NOT overwritten unless overwrite=true.",
    inputSchema: {
      type: "object",
      properties: {
        input_path: { type: "string", description: "Absolute path to the .tar.gz export archive." },
        slugs: { type: "array", items: { type: "string" }, description: "Which authors from the bundle to import. Ignored if all=true." },
        all: { type: "boolean", default: false, description: "Import all authors in the bundle." },
        overwrite: { type: "boolean", default: false, description: "If true, overwrite existing authors with the same slug. Otherwise skip them." },
      },
      required: ["input_path"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function okText(text) {
  return { content: [{ type: "text", text }] };
}

function err(message, extra = {}) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
}

const handlers = {
  async list_authors() {
    const authors = await listAuthors();
    return ok({ root: defaultRoot(), authors });
  },

  async create_author({ slug, display_name, description = "" }) {
    ensureSlug(slug);
    try {
      const meta = await createAuthor({ slug, displayName: display_name, description });
      return ok({ created: meta });
    } catch (e) {
      if (e.code === "EEXIST") return err(e.message);
      throw e;
    }
  },

  async delete_author({ slug, confirm }) {
    ensureSlug(slug);
    if (confirm !== true) {
      return err("delete_author requires confirm=true");
    }
    try {
      await deleteAuthor(slug);
      return ok({ deleted: slug });
    } catch (e) {
      if (e.code === "ENOENT") return err(e.message);
      throw e;
    }
  },

  async get_writing_guide({ slug }) {
    ensureSlug(slug);
    const meta = await getAuthor(slug);
    if (!meta) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);

    const overlay = (await readText(paths.overlay)) ?? "";
    const stylePatternsRaw = (await readText(paths.stylePatterns)) ?? "";
    const learned = (await readText(paths.learnedRules)) ?? "";
    const observations = (await readText(paths.observations)) ?? "";

    // Re-sample examples from observations on each read
    const stylePatterns = resampleExamples(stylePatternsRaw, observations);

    const protocol = `
# Protocol reminder (from styleforge)

When writing in this author's style:

1. Replicate STRUCTURE / SYNTAX / RHETORIC ONLY. Do NOT import the author's
   political stance unless the user explicitly asks. The user's stated
   stance always wins.
2. Be wary of low-frequency patterns — frequencies based on small
   corpora (under ~15 articles) are not statistically meaningful yet.
3. Respect density guidance (em-dashes, colloquial inserts) — don't apply
   every rule on every paragraph.
4. After writing, self-check against the §4 "failure modes" section.
5. Offer briefly to record feedback via record_feedback so style-feedback
   can pick it up later.
`.trim();

    return okText(
      [
        `# Writing guide for: ${meta.display_name} (${slug})`,
        "",
        protocol,
        "",
        "---",
        "",
        "## SKILL_OVERLAY (per-author preferences)",
        "",
        overlay.trim() || "_(empty)_",
        "",
        "---",
        "",
        "## style-patterns.md",
        "",
        stylePatterns.trim() || "_(empty)_",
        "",
        "---",
        "",
        "## observations.md (pattern descriptions & examples)",
        "",
        observations.trim() || "_(empty)_",
        "",
        "---",
        "",
        "## learned-rules.md (from feedback)",
        "",
        learned.trim() || "_(none yet)_",
      ].join("\n"),
    );
  },

  async sample_corpus({ slug, topic = null, k = 5 }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const entries = await bucketedSample(paths, { topic, k });
    // Return signature passages inline — no need to read full files.
    // Entries without passages yet are included with an empty array.
    const slim = entries.map((e) => ({
      entry_id: e.entry_id,
      title: e.title,
      topics: e.topics,
      signature_passages: e.signature_passages || [],
    }));
    return ok({ samples: slim });
  },

  async ingest_dryrun({ slug, files, threshold = 6 }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const resolved = await Promise.all(files.map(safeResolve));
    const plan = await planIngest(paths, resolved, { hammingThreshold: threshold });
    return ok({ mode: "dry_run", plan });
  },

  async ingest_execute({ slug, files, weight = 1.0, allow_near = false, skip_near = false, threshold = 6, no_snapshot = false, message = "" }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    return withAuthorLock(slug, async () => {
      const paths = new AuthorPaths(slug);
      const resolved = await Promise.all(files.map(safeResolve));
      const plan = await planIngest(paths, resolved, { hammingThreshold: threshold });

      if (plan.near_duplicates.length > 0 && !allow_near && !skip_near) {
        return err("near-duplicates detected; re-run with allow_near=true or skip_near=true after user confirmation", {
          plan,
        });
      }

      const result = await executeIngest(paths, plan, {
        weight,
        takeSnapshot: !no_snapshot,
        allowNear: allow_near,
        message,
      });
      return ok({ mode: "executed", ...result });
    });
  },

  async record_pattern_evidence({ slug, entry_id, topics = [], pattern_ids = [] }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    return withAuthorLock(slug, async () => {
      const paths = new AuthorPaths(slug);
      const index = await loadIndex(paths.corpusIndex);
      const entry = index.entries.find((e) => e.entry_id === entry_id);
      if (!entry) return err(`entry ${entry_id} not found in corpus`);
      entry.topics = Array.from(new Set([...(entry.topics || []), ...topics]));
      entry.pattern_ids = Array.from(new Set([...(entry.pattern_ids || []), ...pattern_ids]));
      await saveIndex(paths.corpusIndex, index);
      await logAction(paths, "record_pattern_evidence", {
        details: { entry_id, topics, pattern_ids },
      });
      return ok({ updated: { entry_id, topics: entry.topics, pattern_ids: entry.pattern_ids } });
    });
  },

  async record_signature_passages({ slug, entry_id, passages }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    return withAuthorLock(slug, async () => {
      const paths = new AuthorPaths(slug);
      const index = await loadIndex(paths.corpusIndex);
      const entry = index.entries.find((e) => e.entry_id === entry_id);
      if (!entry) return err(`entry ${entry_id} not found in corpus`);
      // Truncate each passage to 120 chars, dedupe.
      const trimmed = [...new Set(passages.map((p) => p.trim().slice(0, 120)))];
      entry.signature_passages = trimmed;
      await saveIndex(paths.corpusIndex, index);
      await logAction(paths, "record_signature_passages", {
        details: { entry_id, count: trimmed.length },
      });
      return ok({ updated: { entry_id, signature_passages: trimmed } });
    });
  },

  async append_observation({ slug, candidate_id, description, example = "", entry_id }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const stamp = new Date().toISOString();
    const block = [
      `## ${candidate_id}`,
      `- 描述: ${description}`,
      example ? `- 例: ${example.trim().slice(0, 80)}` : null,
      `- 出处: ${entry_id}`,
      `- 添加于: ${stamp}`,
      "",
    ].filter(Boolean).join("\n");
    // Ensure double-newline before ## so sections never concatenate.
    await appendText(paths.observations, "\n\n" + block);
    await logAction(paths, "append_observation", {
      details: { candidate_id, entry_id },
    });
    return ok({ appended: candidate_id });
  },

  async recompute_stats({ slug }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    return withAuthorLock(slug, async () => {
      const paths = new AuthorPaths(slug);
      const stats = await recomputeStats(paths);
      return ok({
        patterns: Object.values(stats)
          .sort((a, b) => b.weighted_count - a.weighted_count)
          .map((s) => ({
            pattern_id: s.pattern_id,
            count: s.raw_count,
            frequency: Number(s.frequency.toFixed(3)),
          })),
      });
    });
  },

  async get_stats({ slug }) {
    ensureSlug(slug);
    const meta = await getAuthor(slug);
    if (!meta) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const stats = await recomputeStats(paths);
    const index = await loadIndex(paths.corpusIndex);
    const topics = {};
    for (const e of index.entries) {
      if (!e.topics || e.topics.length === 0) {
        topics._untagged = (topics._untagged || 0) + 1;
      } else {
        for (const t of e.topics) topics[t] = (topics[t] || 0) + 1;
      }
    }
    const sampleWarning = index.entries.length < 15
      ? `corpus has only ${index.entries.length} entries — pattern frequencies are not yet statistically meaningful (rule of thumb: need 15+ entries for reliable frequency data).`
      : null;
    return ok({
      author: meta.display_name,
      slug: meta.slug,
      entries: index.entries.length,
      topics,
      sample_warning: sampleWarning,
      patterns: Object.values(stats)
        .sort((a, b) => b.weighted_count - a.weighted_count)
        .map((s) => ({
          pattern_id: s.pattern_id,
          count: s.raw_count,
          frequency: Number(s.frequency.toFixed(3)),
        })),
    });
  },

  async create_snapshot({ slug, label = "" }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const snap = await createSnapshot(paths, { label });
    await logAction(paths, "snapshot", { details: { label }, snapshot: snap.name });
    return ok({ snapshot: snap.name, label: snap.label });
  },

  async list_snapshots({ slug }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const snaps = await listSnapshots(paths);
    return ok({
      snapshots: snaps.map((s) => ({
        name: s.name,
        label: s.label || "",
        created_at: s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt,
      })),
    });
  },

  async rollback({ slug, to, only }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    try {
      const pre = await rollbackTo(paths, to, { only });
      await logAction(paths, "rollback", {
        details: { to, only: only && only.length ? only : "all" },
        snapshot: pre.name,
      });
      return ok({ rolled_back_to: to, pre_rollback_snapshot: pre.name });
    } catch (e) {
      if (e.code === "ENOENT") return err(e.message);
      throw e;
    }
  },

  async record_feedback({ slug, task, issues, expected = "", output_ref = "" }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const stamp = new Date().toISOString();
    const block = [
      "",
      `## ${stamp}`,
      `- task: ${task}`,
      `- issues: ${issues}`,
      expected ? `- expected: ${expected}` : null,
      output_ref ? `- output_ref: ${output_ref}` : null,
      "",
    ].filter(Boolean).join("\n");
    await appendText(paths.feedbackLog, block);
    await logAction(paths, "record_feedback", { details: { task } });
    return ok({ logged_at: stamp });
  },

  async get_feedback_log({ slug }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const text = (await readText(paths.feedbackLog)) ?? "";
    return okText(text);
  },

  async apply_learned_rule({ slug, rule_id, trigger, corrective_action, confidence = "medium", feedback_refs = [] }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    // Snapshot first.
    const snap = await createSnapshot(paths, { label: `pre-apply-learned-rule-${rule_id}` });
    const stamp = new Date().toISOString();
    const block = [
      "",
      `## ${stamp} — ${rule_id}`,
      `**触发情景**: ${trigger}`,
      "",
      `**修正动作**: ${corrective_action}`,
      "",
      `**信心**: ${confidence}`,
      feedback_refs.length ? `**反馈依据**: ${feedback_refs.join(", ")}` : null,
      "",
    ].filter(Boolean).join("\n");
    await appendText(paths.learnedRules, block);
    await logAction(paths, "apply_learned_rule", {
      details: { rule_id, confidence, feedback_refs },
      snapshot: snap.name,
    });
    return ok({ applied: rule_id, snapshot: snap.name });
  },

  async save_draft({ slug, content, title = "" }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    await fs.mkdir(paths.draftsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = title
      ? title.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 60)
      : ts;
    const filename = `${safeName}.md`;
    let dest = path.join(paths.draftsDir, filename);
    // Disambiguate if exists.
    let i = 2;
    while (true) {
      try { await fs.access(dest); dest = path.join(paths.draftsDir, `${safeName}-${i}.md`); i++; }
      catch { break; }
    }
    await fs.writeFile(dest, content, "utf-8");
    await logAction(paths, "save_draft", { details: { path: dest } });
    return ok({ saved: dest });
  },

  async export_author({ slugs = [], all = false, output_path = "" }) {
    // Determine which authors to export.
    let toExport;
    if (all) {
      toExport = (await listAuthors()).map((a) => a.slug);
    } else {
      if (!slugs || slugs.length === 0) return err("provide slugs or set all=true");
      for (const s of slugs) ensureSlug(s);
      toExport = slugs;
    }

    if (toExport.length === 0) return err("no authors found to export");

    // Verify all exist.
    for (const slug of toExport) {
      if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    }

    // Determine output path.
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = output_path
      ? path.resolve(output_path)
      : path.join(os.homedir(), `styleforge-export-${ts}.tar.gz`);

    await fs.mkdir(path.dirname(dest), { recursive: true });

    // tar from the authors directory, including only selected slugs.
    // Exclude: snapshots/, .DS_Store, drafts/
    const authorsBase = authorsDir();
    const args = [
      "czf", dest,
      "--exclude", "snapshots",
      "--exclude", ".DS_Store",
      "--exclude", "drafts",
      "-C", authorsBase,
      ...toExport,
    ];
    await execFileAsync("tar", args);

    const stat = await fs.stat(dest);
    return ok({
      exported: toExport,
      path: dest,
      authors_count: toExport.length,
      size_bytes: stat.size,
    });
  },

  async import_author({ input_path, slugs = [], all = false, overwrite = false }) {
    if (!input_path) return err("input_path is required");
    const resolved = path.resolve(input_path);

    try {
      await fs.access(resolved);
    } catch {
      return err(`file not found: ${resolved}`);
    }

    // List top-level directories in the tar to discover available authors.
    const { stdout } = await execFileAsync("tar", ["tzf", resolved]);
    const available = [...new Set(
      stdout.split("\n")
        .map((l) => l.split("/")[0])
        .filter((s) => s && isValidSlug(s))
    )];

    if (available.length === 0) return err("no valid author directories found in archive");

    // Determine which authors to import.
    let toImport;
    if (all) {
      toImport = available;
    } else if (slugs && slugs.length > 0) {
      for (const s of slugs) {
        if (!available.includes(s)) return err(`author ${s} not found in archive (available: ${available.join(", ")})`);
      }
      toImport = slugs;
    } else {
      return err(`specify slugs or set all=true. Available in archive: ${available.join(", ")}`);
    }

    const authorsBase = authorsDir();
    await fs.mkdir(authorsBase, { recursive: true });

    const results = { imported: [], skipped: [], overwritten: [] };

    for (const slug of toImport) {
      ensureSlug(slug);
      const paths = new AuthorPaths(slug);
      const exists = await fs.stat(paths.base).then(() => true).catch(() => false);

      if (exists && !overwrite) {
        results.skipped.push(slug);
        continue;
      }
      if (exists && overwrite) {
        await fs.rm(paths.base, { recursive: true, force: true });
        results.overwritten.push(slug);
      }

      // Extract only this author's directory from the archive.
      await execFileAsync("tar", ["xzf", resolved, "-C", authorsBase, slug]);
      results.imported.push(slug);
    }

    return ok(results);
  },
};

// ---------------------------------------------------------------------------
// Prompts (slash-command shortcuts)
//
// Prompts in MCP show up as "/prompt-name" in clients that surface them
// (Claude Desktop does). They're functionally equivalent to skill files —
// when invoked, the prompt text is injected as a user message that tells the
// agent how to proceed. Tools do the actual work.
// ---------------------------------------------------------------------------

const PROMPTS = {
  "style-write": {
    description: "Write or rewrite a piece in a specific author's style. Just say what you want written after selecting this.",
    arguments: [],
    build() {
      return [
        "I want you to write in the style of a specific styleforge author.",
        "Follow this protocol exactly:",
        "",
        "1. Call `list_authors`. If there's only one, use it. Otherwise ask which one.",
        "2. Call `get_writing_guide` for that slug. Read the returned guide carefully.",
        "3. Call `sample_corpus` (k=5-8) — returns signature passages: short, context-agnostic",
        "   style exemplars showing syntax/rhythm/rhetoric. Use these to calibrate voice.",
        "4. Ask the user what they want written (if they haven't already said).",
        "5. Draft the piece. Strict rule: replicate STRUCTURE / SYNTAX / RHETORIC ONLY.",
        "   Do NOT import the author's political stance into a topic the user did not ask for.",
        "   The user's stated stance always wins. Signature passages inform HOW to write,",
        "   not WHAT to write — never leak their content into the output.",
        "6. Self-check against the §4 'failure modes' section of style-patterns.md.",
        "7. Call `save_draft` with the final text. Show the user the returned file path.",
        "8. Deliver. Then briefly: \"Satisfied? If not, tell me what's off and I'll log it via record_feedback.\"",
      ].join("\n");
    },
  },
  "style-ingest": {
    description: "Ingest new articles into an author's corpus. Provide local file paths on your machine.",
    arguments: [],
    build() {
      return [
        "Ingest articles into a styleforge author's corpus. Follow this exactly:",
        "",
        "1. Call `list_authors`. If there's only one, use it. Otherwise ask which one.",
        "2. Ask the user for file paths (must be local paths on their machine, e.g. ~/Documents/...).",
        "   If user pasted text, save each as a separate .txt under a sensible name first.",
        "3. **Batch limit: 5 files**. Split larger batches and walk each through the full flow.",
        "4. Call `ingest_dryrun`. Show the user: new_files / exact_duplicates / near_duplicates.",
        "   If near_duplicates exist, ask explicitly: (a) treat as new, (b) skip, (c) cancel.",
        "5. After confirmation, call `ingest_execute`. **Important**: pass a `message` parameter",
        "   summarizing what was ingested (e.g. 'ingest 3 articles about Song dynasty history').",
        "   This message is stored with the snapshot so the user can identify it later during rollback.",
        "6. **Enrichment (critical)**: for each new entry, view the source file, then:",
        "   a. Call `record_pattern_evidence` with topics + pattern_ids. Pull pattern_ids from the",
        "      author's existing style-patterns.md (call `get_writing_guide`). Novel patterns",
        "      go through `append_observation`, not record_pattern_evidence.",
        "   b. Call `record_signature_passages` with 3-5 short (≤120 char) context-agnostic passages",
        "      that demonstrate the author's syntax/rhythm/rhetoric WITHOUT topical content.",
        "      Strip proper nouns, dates, domain references — keep only the stylistic skeleton.",
        "7. Call `recompute_stats`.",
        "8. Report: ingested count, snapshot id, rollback hint.",
      ].join("\n");
    },
  },
  "style-feedback": {
    description: "Digest accumulated feedback into actionable learned-rules for an author.",
    arguments: [],
    build() {
      return [
        "Process accumulated feedback for a styleforge author. Follow this exactly:",
        "",
        "1. Call `list_authors`. If there's only one, use it. Otherwise ask which one.",
        "2. Call `get_feedback_log` to read all entries.",
        "3. Call `create_snapshot` with label `pre-feedback-review`.",
        "4. Group recurring failure modes. Single occurrences are weak candidates.",
        "   Contradictory feedback should be SHOWN to the user, not auto-resolved.",
        "5. Present a numbered list of proposed learned-rules. For each:",
        "   trigger / corrective_action / source_feedback / confidence.",
        "6. Wait for user accept/reject/edit on each.",
        "7. For each accepted (or user-edited) proposal, call `apply_learned_rule` with the",
        "   final wording.",
        "8. Briefly report: K accepted, K rejected, snapshot id for rollback.",
        "",
        "Never: modify style-patterns.md directly, accept proposals without confirmation,",
        "or strip original feedback log entries.",
      ].join("\n");
    },
  },
  "style-rollback": {
    description: "Roll back an author's state to a previous snapshot.",
    arguments: [],
    build() {
      return [
        "Help the user roll back a styleforge author to a previous state. Follow this exactly:",
        "",
        "1. Call `list_authors`. If there's only one, use it. Otherwise ask which one.",
        "2. Call `list_snapshots` for that slug.",
        "3. Present the snapshots as a numbered list, newest first. For each show:",
        "   - timestamp (human-readable)",
        "   - label/message (this is the commit message describing what happened)",
        "4. Ask the user which snapshot to roll back to.",
        "5. After the user picks one, call `rollback` with the chosen snapshot name.",
        "6. Report success and the pre-rollback snapshot name (in case they want to undo).",
      ].join("\n");
    },
  },
  "style-authors": {
    description: "List all registered styleforge authors.",
    arguments: [],
    build() {
      return "Call `list_authors` and present the results as a concise table (slug, display name).";
    },
  },
  "style-stats": {
    description: "Show corpus statistics for a styleforge author.",
    arguments: [],
    build() {
      return [
        "Show statistics for a styleforge author.",
        "",
        "1. Call `list_authors`. If there's only one, use it. Otherwise ask which one.",
        "2. Call `get_stats` for that slug.",
        "3. Present the result clearly: entry count, topic breakdown, pattern frequencies, and any sample_warning.",
      ].join("\n");
    },
  },
  "style-export": {
    description: "Export one or more authors as a portable JSON bundle. Use -A to export all.",
    arguments: [],
    build() {
      return [
        "Export styleforge authors to a portable JSON bundle. Follow this exactly:",
        "",
        "1. Call `list_authors` to show available authors.",
        "2. Ask the user which authors to export, or if they said `-A` / `all`, export all.",
        "3. Optionally ask for an output path (default: ~/styleforge-export-<timestamp>.json).",
        "4. Call `export_author` with the chosen slugs (or all=true).",
        "5. Report the output file path and how many authors were exported.",
      ].join("\n");
    },
  },
  "style-import": {
    description: "Import authors from a previously exported JSON bundle. Use -A to import all.",
    arguments: [],
    build() {
      return [
        "Import styleforge authors from a JSON export bundle. Follow this exactly:",
        "",
        "1. Ask the user for the path to the export .json file.",
        "2. Call `import_author` with input_path and all=true (just to peek — with a dry check).",
        "   Actually: call `import_author` with the path and no slugs/all to see what's available.",
        "   The error response will list available authors in the bundle.",
        "3. If user said `-A` / `all`, set all=true. Otherwise ask which authors to import.",
        "4. If any authors already exist locally, ask if they want to overwrite (overwrite=true) or skip.",
        "5. Call `import_author` with the final parameters.",
        "6. Report: imported / skipped / overwritten counts.",
      ].join("\n");
    },
  },
  "style-help": {
    description: "Show the styleforge user guide — from ingestion to writing to feedback.",
    arguments: [],
    build() {
      return [
        "Print the following user guide directly to the user. Do NOT call any MCP tools.",
        "",
        "# Styleforge — User Guide",
        "",
        "Styleforge clones an author's **writing style** (syntax, rhythm, rhetoric) and applies it to any new topic.",
        "",
        "## Workflow",
        "",
        "```",
        "Create author → Ingest corpus → Write → Feedback → Iterate",
        "```",
        "",
        "### 1. Create an author",
        "Run `/style-authors` to check existing authors. To create one, just say: \"create a styleforge author called 张三\".",
        "",
        "### 2. Ingest corpus (`/style-ingest`)",
        "Provide local file paths. Each article is:",
        "- Deduplicated (SHA-256 exact + SimHash near-duplicate detection)",
        "- Analyzed across five layers: syntax, rhetoric, structure, register, rhythm",
        "- Extracted into **signature passages** — style templates with content words replaced by placeholders like `[人物]`, `[事件]`, `[概念]`",
        "",
        "Tip: ingest 10-15+ articles for statistically meaningful patterns.",
        "",
        "### 3. Write (`/style-write <topic>`)",
        "The writing guide + signature passages calibrate voice. Only **how** the author writes is transferred, never **what** they think.",
        "Drafts are auto-saved as `.md` files in `~/.styleforge/authors/<slug>/drafts/` — the path is shown after every write.",
        "",
        "### 4. Feedback (`/style-feedback`)",
        "After a write, say what's off. The agent logs it. When feedback accumulates, `/style-feedback` groups issues into learned rules you approve individually.",
        "",
        "### 5. Stats (`/style-stats`) & Rollback (`/style-rollback`)",
        "Check corpus health. Every mutation snapshots state first — rollback-of-rollback works.",
        "",
        "### 6. Export & Import (`/style-export`, `/style-import`)",
        "Export authors as portable JSON bundles to share or back up. Import from bundles to restore or transfer between machines.",
        "Use `-A` to export/import all authors at once.",
        "",
        "## Commands",
        "",
        "| Command | Description |",
        "|---------|-------------|",
        "| `/style-help` | This guide |",
        "| `/style-authors` | List registered authors |",
        "| `/style-ingest` | Ingest articles into corpus |",
        "| `/style-write` | Write in an author's style (auto-saves .md) |",
        "| `/style-feedback` | Digest feedback into learned rules |",
        "| `/style-stats` | Corpus statistics |",
        "| `/style-rollback` | Restore a snapshot |",
        "| `/style-export` | Export authors as a portable bundle |",
        "| `/style-import` | Import authors from a bundle |",
        "",
        "Data lives under `~/.styleforge/` (or `$STYLEFORGE_HOME`). Each author is fully isolated.",
      ].join("\n");
    },
  },
};

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function ensureRootExists() {
  const root = defaultRoot();
  await fs.mkdir(path.join(root, "authors"), { recursive: true });
  const config = path.join(root, "config.toml");
  try {
    await fs.access(config);
  } catch {
    await writeTextAtomic(config, `# styleforge config\nversion = "0.1.0"\n`);
  }
}

const server = new Server(
  { name: "styleforge", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return err(`unknown tool: ${name}`);
  }
  try {
    return await handler(args);
  } catch (e) {
    return err(e.message || String(e));
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: Object.entries(PROMPTS).map(([name, p]) => ({
      name,
      description: p.description,
      arguments: p.arguments,
    })),
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const prompt = PROMPTS[name];
  if (!prompt) throw new Error(`unknown prompt: ${name}`);
  return {
    messages: [
      {
        role: "user",
        content: { type: "text", text: prompt.build(args) },
      },
    ],
  };
});

(async () => {
  try {
    await ensureRootExists();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("styleforge MCP server running on stdio");
  } catch (e) {
    console.error(`styleforge fatal: ${e.stack || e.message}`);
    process.exit(1);
  }
})();
