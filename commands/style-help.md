---
description: Show the styleforge user guide — from ingestion to writing to feedback
allowed-tools: []
---

Print the following user guide verbatim (do NOT call any MCP tools):

---

# Styleforge — User Guide

Styleforge lets you clone an author's **writing style** — their syntax, rhythm, and rhetoric — and apply it to any new topic. Below is the full workflow.

## 1. Create an author

```
/style-authors          ← check if the author already exists
```

If not, just say: **"create a styleforge author called 张三"**. You'll be asked for a slug (lowercase id) and display name.

## 2. Ingest corpus

```
/style-ingest
```

Provide local file paths to the author's articles (txt, md, etc.). What happens:

1. **Dry run** — deduplication check (exact + near-duplicate detection). You approve before anything is written.
2. **Ingest** — files are copied into the author's `corpus/` directory and indexed.
3. **Enrichment** — each article is analyzed across five dimensions:
   - **Syntax** — sentence length, clause nesting, punctuation rhythm
   - **Rhetoric** — metaphor types, rhetorical questions, parallelism, citation style
   - **Structure** — opening patterns, paragraph progression, closing techniques
   - **Register** — colloquial insertions, classical/modern mixing, jargon density
   - **Rhythm** — long-short sentence alternation, climax/rest placement
4. **Signature passages** — 3-5 short style templates per article are extracted. These keep the author's sentence skeleton (syntax, punctuation, rhetorical structure) but replace content words with placeholders like `[人物]`, `[事件]`, so they can calibrate voice without contaminating future writing.
5. **Stats recompute** — pattern frequencies are updated across the entire corpus.

**Tip**: ingest at least 10-15 articles for statistically meaningful patterns.

## 3. Write in the author's style

```
/style-write <what you want written>
```

What happens behind the scenes:

1. The **writing guide** is loaded (style-patterns + learned-rules).
2. **Signature passages** are sampled from the corpus — context-free style templates that calibrate voice.
3. Your piece is drafted: style is transferred, content is yours.
4. The draft is **auto-saved** as a `.md` file in `~/.styleforge/authors/<slug>/drafts/` — the path is shown to you.
5. You're asked for feedback.

**Key rule**: styleforge transfers **how** the author writes, not **what** they think. The author's political stance, opinions, and factual claims are never imported unless you explicitly ask.

## 4. Give feedback

After a `/style-write`, if something feels off, just say what's wrong. The agent logs it via `record_feedback`.

When you've accumulated several feedback entries:

```
/style-feedback
```

This reviews all feedback, groups recurring issues, and proposes **learned rules** (trigger → corrective action). You approve or reject each one. Approved rules are persisted and automatically applied in future writes.

## 5. Check stats

```
/style-stats
```

Shows corpus size, topic breakdown, and pattern frequencies. Useful to see if more corpus is needed.

## 6. Roll back

```
/style-rollback
```

Every write operation (ingest, feedback, learned-rule) creates an automatic snapshot. You can roll back to any previous state. Rollback-of-rollback also works.

## Commands at a glance

| Command | What it does |
|---------|-------------|
| `/style-help` | This guide |
| `/style-authors` | List all registered authors |
| `/style-ingest` | Ingest new articles into corpus |
| `/style-write` | Write in an author's style (auto-saves to .md) |
| `/style-feedback` | Digest feedback into learned rules |
| `/style-stats` | Show corpus statistics |
| `/style-rollback` | Restore a previous snapshot |

## Data location

All data lives under `~/.styleforge/` (or wherever `$STYLEFORGE_HOME` points). Each author is fully isolated — operations on one never affect another.

---
