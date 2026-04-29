---
name: styleforge
description: Use this skill when the user wants to "write in someone's style", "imitate an author", "use styleforge", manage writing-style authors, ingest corpus articles, check style stats, roll back style data, or mentions any /style-* command. Also trigger when the user says "write like X", "in the style of X", "style guide", "ingest these articles", "add to corpus", or references a styleforge author slug. This skill orchestrates the styleforge MCP tools for per-author writing-style management.
version: 0.3.1
---

# Styleforge — Writing-Style Management

Styleforge maintains per-author writing-style libraries via MCP tools. Each author has an isolated corpus, style patterns, learned rules, and snapshots.

## Available Operations

### Write in an author's style (`/style-write`)

1. Call `list_authors`. If only one exists, use it. Otherwise ask which one.
2. Call `get_writing_guide` for that slug — read the returned SKILL_OVERLAY + style-patterns + learned-rules carefully.
3. Optionally call `sample_corpus` (k=2-3) for grounding examples.
4. Ask the user what to write (if they haven't already said).
5. Draft the piece. Replicate STRUCTURE / SYNTAX / RHETORIC ONLY. Do NOT import the author's political stance unless the user explicitly requests it. The user's stated stance always wins.
6. Self-check against the §4 "failure modes" section of style-patterns.md.
7. Deliver. Then briefly ask: "Satisfied? If not, tell me what's off and I'll log it via `record_feedback`."

### Ingest new corpus (`/style-ingest`)

1. Call `list_authors`. If only one, use it. Otherwise ask.
2. Ask for local file paths on the user's machine (e.g. `~/Documents/articles/`). Files must be accessible from the local filesystem — uploaded/sandboxed files won't work.
3. Call `ingest_dryrun`. Show the user: new_files / exact_duplicates / near_duplicates. If near-dups exist, ask: (a) treat as new, (b) skip, (c) cancel.
4. After confirmation, call `ingest_execute` with a descriptive `message` parameter (e.g. "ingest 3 articles about Song dynasty history"). This labels the snapshot for later rollback identification.
5. **Ingest Plan**: After `ingest_execute` succeeds, display an Ingest Plan summary before enrichment:
   - Total articles to annotate (= number of successfully ingested entries)
   - Batch layout: groups of ≤3 articles each, with estimated word count per batch
   - If any single file exceeds 100k words, note it will be split into shorter chunks for annotation
   - Example format:
     ```
     Ingest Plan
     ───────────
     Articles to annotate: 7
     Batches: 3  (batch 1: articles 1-3 ~18k words | batch 2: articles 4-6 ~22k words | batch 3: article 7 ~9k words)
     Splits: none
     Proceeding with enrichment...
     ```
   - Do NOT ask for user approval here — proceed automatically.
6. **Enrichment (parallel batched)**: Annotate ingested articles using parallel agents.
   - Split the ingested articles into batches of ≤3 articles. Each batch's combined word count must not exceed 100k words; if a single article exceeds 100k words, split it into shorter chunks that each fit within the limit.
   - Launch one parallel agent per batch. Each agent reads its assigned articles and calls `record_pattern_evidence` (topics + pattern_ids from the author's style-patterns.md catalog) for each article. Novel patterns go through `append_observation`.
   - Wait for all batch agents to complete before proceeding.
7. Call `recompute_stats`.
8. Report: ingested count, snapshot id, rollback hint.

### Process feedback (`/style-feedback`)

1. Call `list_authors`, confirm slug.
2. Call `get_feedback_log` to read all entries.
3. Call `create_snapshot` with label `pre-feedback-review`.
4. Group recurring failure modes. Contradictory feedback: show to user, don't auto-resolve.
5. Present proposed learned-rules: trigger / corrective_action / confidence.
6. Wait for user accept/reject/edit on each.
7. For accepted proposals, call `apply_learned_rule`.
8. Report: K accepted, K rejected, snapshot id.

### Roll back (`/style-rollback`)

1. Call `list_authors`, confirm slug.
2. Call `list_snapshots`.
3. Present numbered list (newest first) with timestamp and label/message.
4. Ask user which to restore.
5. Call `rollback`. Report success and pre-rollback snapshot name.

### List authors (`/style-authors`)

Call `list_authors`, present as a concise table (slug, display name).

### Show stats (`/style-stats`)

1. Confirm author slug.
2. Call `get_stats`.
3. Present: entry count, topic breakdown, pattern frequencies, sample_warning if applicable.

## Important Notes

- All file paths for ingest must be local to the user's machine (not sandbox paths like `/mnt/user-data/`).
- The MCP server stores data at `$STYLEFORGE_HOME` (default `~/.styleforge/`).
- Each author is fully isolated — operations on one never touch another.
- Snapshots are automatic before every write operation. Rollback-of-rollback works.
- When corpus is small (< 15 entries), all rules are "candidate" — frequencies are not statistically meaningful yet.
