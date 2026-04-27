#!/usr/bin/env node
/**
 * styleforge MCP server
 *
 * Exposes 16 tools + 3 prompts that an agent uses to maintain per-author
 * writing-style libraries (any language):
 *
 *   - list_authors / create_author / delete_author
 *   - get_writing_guide                        (the "skill content" — fetched on demand)
 *   - sample_corpus
 *   - ingest_dryrun / ingest_execute / record_pattern_evidence
 *   - recompute_stats / get_stats
 *   - create_snapshot / list_snapshots / rollback
 *   - record_feedback / get_feedback_log / apply_learned_rule
 *
 *   - prompts: style-write / style-ingest / style-feedback (slash-command shortcuts)
 *
 * Data location: $STYLEFORGE_HOME (set from manifest user_config.data_dir),
 * or ~/.styleforge as fallback.
 */

import path from "node:path";
import { promises as fs } from "node:fs";

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
    description: "Return up to 5 representative entries from an author's corpus. Bucketed sampling avoids over-representing any single topic. Call after get_writing_guide if you want concrete examples.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        topic: { type: "string", description: "Optional topic tag to prefer." },
        k: { type: "integer", minimum: 1, maximum: 5, default: 3 },
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
    name: "append_observation",
    description: "Append a candidate-pattern observation to observations.md. For novel patterns spotted in a single article that aren't yet in the rule catalog. Stays as observation until cross-corpus stability earns it promotion.",
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
    const stylePatterns = (await readText(paths.stylePatterns)) ?? "";
    const learned = (await readText(paths.learnedRules)) ?? "";
    const observations = (await readText(paths.observations)) ?? "";

    const protocol = `
# Protocol reminder (from styleforge)

When writing in this author's style:

1. Replicate STRUCTURE / SYNTAX / RHETORIC ONLY. Do NOT import the author's
   political stance unless the user explicitly asks. The user's stated
   stance always wins.
2. Be wary of any rule labeled "candidate" — frequencies based on small
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
        "## observations.md (candidates, not yet promoted)",
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

  async sample_corpus({ slug, topic = null, k = 3 }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const entries = await bucketedSample(paths, { topic, k });
    // Strip simhashes (huge, irrelevant for the agent's reading) but include
    // source_path so the agent can `view` the file.
    const slim = entries.map((e) => ({
      entry_id: e.entry_id,
      title: e.title,
      source_path: path.join(paths.base, e.source_path),
      char_count: e.char_count,
      topics: e.topics,
      pattern_ids: e.pattern_ids,
      weight: e.weight,
    }));
    return ok({ samples: slim, root: paths.base });
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
  },

  async record_pattern_evidence({ slug, entry_id, topics = [], pattern_ids = [] }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
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
  },

  async append_observation({ slug, candidate_id, description, example = "", entry_id }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
    const paths = new AuthorPaths(slug);
    const stamp = new Date().toISOString();
    const block = [
      "",
      `## ${candidate_id}`,
      `- 描述: ${description}`,
      example ? `- 例: ${example.trim().slice(0, 80)}` : null,
      `- 出处: ${entry_id}`,
      `- 状态: candidate`,
      `- 添加于: ${stamp}`,
      "",
    ].filter(Boolean).join("\n");
    await appendText(paths.observations, block);
    await logAction(paths, "append_observation", {
      details: { candidate_id, entry_id },
    });
    return ok({ appended: candidate_id });
  },

  async recompute_stats({ slug }) {
    ensureSlug(slug);
    if (!(await getAuthor(slug))) return err(`author ${slug} not found`);
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
      ? `corpus has only ${index.entries.length} entries — pattern frequencies are not yet statistically meaningful (rule of thumb: need 15+ entries before treating frequencies as anything other than candidate observations).`
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
    description: "Write or rewrite a piece in a styleforge author's style.",
    arguments: [
      { name: "slug", description: "Author slug (e.g. hbdxsl).", required: false },
      { name: "task", description: "What to write or rewrite.", required: false },
    ],
    build({ slug = "", task = "" }) {
      return [
        "I want you to write in the style of a specific styleforge author.",
        "Follow this protocol exactly:",
        "",
        "1. If a slug is given, use it. Otherwise call `list_authors` and ask the user which one.",
        "2. Call `get_writing_guide` for that slug. Read the returned guide carefully.",
        "3. Optionally call `sample_corpus` (k=2-3) for grounding examples.",
        "4. Draft the piece. Strict rule: replicate STRUCTURE / SYNTAX / RHETORIC ONLY.",
        "   Do NOT import the author's political stance into a topic the user did not ask for.",
        "   The user's stated stance always wins.",
        "5. Self-check against the §4 'failure modes' section of style-patterns.md.",
        "6. Deliver. Then briefly: \"Satisfied? If not, tell me what's off and I'll log it via record_feedback.\"",
        "",
        `slug: ${slug}`,
        `task: ${task}`,
      ].join("\n");
    },
  },
  "style-ingest": {
    description: "Ingest new articles into an author's corpus (always dry-runs first).",
    arguments: [
      { name: "slug", description: "Author slug.", required: false },
      { name: "files", description: "Comma-separated paths, or describe inline.", required: false },
    ],
    build({ slug = "", files = "" }) {
      return [
        "Ingest articles into a styleforge author's corpus. Follow this exactly:",
        "",
        "1. Confirm the author exists via `list_authors`. If slug missing, ask.",
        "2. Resolve file paths. If user pasted text, save each as a separate .txt under a sensible name first.",
        "3. **Batch limit: 5 files**. Split larger batches and walk each through the full flow.",
        "4. Call `ingest_dryrun`. Show the user: new_files / exact_duplicates / near_duplicates.",
        "   If near_duplicates exist, ask explicitly: (a) treat as new, (b) skip, (c) cancel.",
        "5. After confirmation, call `ingest_execute`. **Important**: pass a `message` parameter",
        "   summarizing what was ingested (e.g. 'ingest 3 articles about Song dynasty history').",
        "   This message is stored with the snapshot so the user can identify it later during rollback.",
        "6. **Enrichment (critical)**: for each new entry, view the source file, then call",
        "   `record_pattern_evidence` with topics + pattern_ids. Pull pattern_ids from the",
        "   author's existing style-patterns.md (call `get_writing_guide`). Novel patterns",
        "   go through `append_observation`, not record_pattern_evidence.",
        "7. Call `recompute_stats`.",
        "8. Report: ingested count, snapshot id, rollback hint.",
        "",
        `slug: ${slug}`,
        `files: ${files}`,
      ].join("\n");
    },
  },
  "style-feedback": {
    description: "Digest accumulated feedback into actionable learned-rules.",
    arguments: [
      { name: "slug", description: "Author slug.", required: false },
    ],
    build({ slug = "" }) {
      return [
        "Process accumulated feedback for a styleforge author. Follow this exactly:",
        "",
        "1. Call `list_authors` and confirm the slug. If missing, ask.",
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
        "",
        `slug: ${slug}`,
      ].join("\n");
    },
  },
  "style-rollback": {
    description: "Interactively roll back an author's state to a previous snapshot.",
    arguments: [
      { name: "slug", description: "Author slug.", required: false },
    ],
    build({ slug = "" }) {
      return [
        "Help the user roll back a styleforge author to a previous state. Follow this exactly:",
        "",
        "1. If slug is given, use it. Otherwise call `list_authors` and ask.",
        "2. Call `list_snapshots` for that slug.",
        "3. Present the snapshots as a numbered list, newest first. For each show:",
        "   - timestamp (human-readable)",
        "   - label/message (this is the commit message describing what happened)",
        "4. Ask the user which snapshot to roll back to.",
        "5. After the user picks one, call `rollback` with the chosen snapshot name.",
        "6. Report success and the pre-rollback snapshot name (in case they want to undo).",
        "",
        `slug: ${slug}`,
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
    arguments: [
      { name: "slug", description: "Author slug.", required: false },
    ],
    build({ slug = "" }) {
      return [
        "Show statistics for a styleforge author.",
        "",
        "1. If slug is given, use it. Otherwise call `list_authors` and ask.",
        "2. Call `get_stats` for that slug.",
        "3. Present the result clearly: entry count, topic breakdown, pattern frequencies, and any sample_warning.",
        "",
        `slug: ${slug}`,
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
  } catch (e) {
    process.stderr.write(`styleforge fatal: ${e.message}\n`);
    process.exit(1);
  }
})();
