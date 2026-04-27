# Adding an author

## 1. Create via conversation

The most natural way — tell your MCP client:

> Create a new styleforge author with slug `lubin` and display name "Lu Bin".

The agent will call `create_author`.

## 2. Slug rules

- Lowercase letters + digits + hyphens + underscores
- Length 2–32
- Used as identifiers in tool calls and `/style-write <slug>` commands

Examples: `hbdxsl`, `lubin`, `zhang-3`

## 3. Prepare initial corpus

Prepare at least 5 representative articles, **ideally 15+**. With fewer than 15, `get_stats` will include a `sample_warning` and all rules are treated as candidates.

Article recommendations:
- Cross-topic (don't use all the same subject)
- Cross-period (different time periods may reflect style evolution)
- Naming convention: `YYYY-MM-DD-<short-name>.txt` for easy sorting and identification

## 4. Ingest corpus

```
/style-ingest lubin
```

Or natural language: "Add all .txt files in ~/Documents/lubin/2026/ to lubin's corpus."

The `/style-ingest` prompt walks the agent through the full flow: `ingest_dryrun` → user confirmation → `ingest_execute` (with a descriptive message) → enrichment (call `record_pattern_evidence` for each article) → `recompute_stats`.

## 5. Enrichment is the critical step

After `ingest_execute` completes, new entries in corpus-index.json still lack `topics` and `pattern_ids`. The agent **must** go through the enrichment step:

- View each new article's source file
- Call `record_pattern_evidence` to write back topics + existing pattern_ids
- For novel patterns, call `append_observation` (goes to observations.md as candidate, not directly into style-patterns.md)

## 6. Write SKILL_OVERLAY.md

If the author has specific preferences the agent should know, edit `$STYLEFORGE_HOME/authors/<slug>/SKILL_OVERLAY.md` directly:

```markdown
## Author-specific preferences

- This author often uses a standalone short sentence at the end of paragraphs as a "cut" — don't merge it into the previous paragraph.
- Occasionally writes in English; keep English paragraphs as-is without translation.
- Avoid discussing X, Y topics (user finds them off-putting after the fact).
```

`get_writing_guide` automatically includes this section when returning the guide to the agent.

## 7. Test

```
/style-write lubin Write a 200-word piece about tea.
```

If unsatisfied, give feedback; after feedback accumulates, run `/style-feedback lubin`.

## 8. Promote observations (after 15+ articles)

Once the corpus reaches 15+ articles, you can manually review observations.md and promote recurring candidate patterns to style-patterns.md §1/§2/§3. This step is currently manual (a `styleforge promote` tool may be added in the future).

Promotion criteria:

- **§1 Core rules** (>=70% frequency) — present in nearly every article
- **§2 Secondary rules** (30%–70% frequency) — present in a significant portion
- **§3 Low-frequency rules** (<30%) — present in some articles, but still characteristic
- **observation** (single article) — not yet promoted

Promotion cannot happen in the automated ingest flow; it must be a deliberate decision after reading the observation log. This prevents "small-sample misleading" — appearing in all 3 of 3 articles does not mean "100% frequency" in a meaningful sense.
