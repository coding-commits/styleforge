---
name: styleforge
description: Use this skill when the user wants to "write in someone's style", "imitate an author", "use styleforge", manage writing-style authors, ingest corpus articles, check style stats, roll back style data, or mentions any /style-* command. Also trigger when the user says "write like X", "in the style of X", "style guide", "ingest these articles", "add to corpus", or references a styleforge author slug. This skill orchestrates the styleforge MCP tools for per-author writing-style management.
version: 0.3.3
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
   - Launch one parallel agent per batch. Each agent reads its assigned articles and performs the analysis described in §Enrichment Analysis Framework below, then calls `record_pattern_evidence` and `append_observation` accordingly.
   - Wait for all batch agents to complete before proceeding.

#### Enrichment Analysis Framework

Each agent MUST analyze articles along the following dimensions. Match findings against existing `style-patterns.md` entries (→ `record_pattern_evidence`). Novel findings not in the catalog → `append_observation`.

**A. 多维度模式提取** — examine each article across these layers:

| Layer | What to look for |
|-------|-----------------|
| 句法 (Syntax) | 句长分布、从句嵌套深度、主语省略频率、标点节奏（逗号密度、破折号/括号使用） |
| 修辞 (Rhetoric) | 比喻类型、反问、排比、引用手法（典故/数据/权威）、夹叙夹议比例 |
| 结构 (Structure) | 开头模式（悬念/观点先行/场景切入）、段落推进逻辑（并列/递进/转折）、收尾手法 |
| 语域 (Register) | 口语插入频率、文白混用程度、术语密度、读者称呼方式 |
| 节奏 (Rhythm) | 长短句交替规律、高潮与舒缓段落的位置分布 |

**B. N-gram 指纹** — identify notable surface-level signatures in each article:
- 连接词搭配（"说白了，就是..."、"换句话说"）
- 段首惯用句式（"问题在于"、"有意思的是"）
- 口头禅/标志性表达
- 高频词组搭配

Directly record any noteworthy n-gram via `append_observation` with the exact phrase in the example field. Do not wait for cross-article confirmation — each batch operates independently, and deduplication happens at the catalog level.

**C. 情绪/态度曲线** — map the tonal trajectory of the article:
- 标注语气变化节奏（如：开头克制 → 中段激烈 → 收尾冷静）
- 识别情绪转折点及其触发手法（反问升温、举例降温、金句收束）
- 如果多篇文章呈现相似弧线模式，作为 pattern 记录

Record arc patterns as observations with `candidate_id` prefix `arc.` (e.g. `arc.restrained-to-intense-to-calm`).
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
