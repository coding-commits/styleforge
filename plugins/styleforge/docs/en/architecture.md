# Architecture

## Three-layer structure

Styleforge is an MCP server running on the user's machine, communicating via stdio with any MCP client.

```
MCP client  ⇄  styleforge MCP server  ⇄  filesystem
                (Node.js, stdio)         (~/.styleforge/)
```

## Tools vs Prompts boundary

Styleforge exposes two MCP capability types:

**Tools** do things — they are functions that accept parameters and return data.
**Prompts** give instructions — they are flow templates invoked by users (as slash commands) or clients, expanding into text that guides the agent.

In styleforge:

| Scenario | Tool | Prompt |
|---|---|---|
| List authors | `list_authors` | — |
| Get full writing guide for an author | `get_writing_guide` | — |
| Complete a writing flow | — | `/style-write` |
| Complete a corpus ingestion flow | — | `/style-ingest` |

Prompts contain no logic — they only tell the agent: "call X first, then call Y, ask the user Z in between." The actual work happens in tools.

## Why LLM and deterministic logic are strictly separated

| Task | Who | Why |
|---|---|---|
| Understand article style highlights | LLM | Requires semantic understanding |
| Tag article topics | LLM | Requires semantic understanding |
| Judge rule promotion/demotion | LLM + user | Requires judgment |
| Compute file SHA-256 | Server | Deterministic, zero tokens |
| Detect near-duplicates (SimHash) | Server | Deterministic, zero tokens |
| Maintain snapshots | Server | Must not miss or err |
| Recompute frequencies | Server | Easy to miscount; automation is more reliable |
| Write CHANGELOG | Server | Must happen every time |

LLM handles what requires *understanding*; Server handles what must be *exact and persistent*.

## Data directory

Each author is fully isolated:

```
$STYLEFORGE_HOME/authors/hbdxsl/
├── meta.json              # slug, display_name, description, created_at
├── SKILL_OVERLAY.md       # User-maintained: author-specific writing constraints
├── corpus/
│   └── 2026-02-03-xxx.txt # Source text (append-only by convention)
├── corpus-index.json      # Structured index (machine read/write)
├── style-patterns.md      # Rule catalog (read by agent, with evidence counts)
├── observations.md        # Candidate observations (not yet promoted)
├── annotated/             # Annotated examples (optional)
├── examples/{good,bad}/   # Output archive
├── feedback/
│   ├── log.md             # Raw feedback
│   └── learned-rules.md   # Distilled corrections
├── snapshots/
│   └── 2026-04-26T14-30-00/
│       ├── corpus-index.json
│       ├── style-patterns.md
│       ├── observations.md
│       ├── SKILL_OVERLAY.md
│       └── feedback/learned-rules.md
└── CHANGELOG.md
```

Why corpus-index is JSON (not markdown): the server reads/writes it frequently and needs stable parsing.
Why style-patterns is markdown: `get_writing_guide` passes its text directly to the agent.

## Writing flow

User: "Write a short piece about sunsets in hbdxsl's style"

```
agent decides → list_authors → finds hbdxsl
             → get_writing_guide(hbdxsl)  ← returns SKILL_OVERLAY+patterns+learned
             → sample_corpus(hbdxsl, k=2)  ← optional, get source text for reference
             → draft                        ← LLM work
             → self-check §4 failure modes
             → deliver
             → record_feedback (optional)
```

## Ingestion flow

User: "Add these articles to hbdxsl"

```
agent → list_authors                     ← verify author exists
     → ingest_dryrun(hbdxsl, [files])    ← preview what will happen
     → report to user
     → user confirms                      ← critical! especially for near-duplicates
     → ingest_execute                     ← actually write, auto-snapshot with message
     → for each new entry:
         view file                        ← LLM reads
         record_pattern_evidence          ← write back topics + pattern_ids
         (possibly append_observation)    ← newly discovered candidate patterns
     → recompute_stats
     → report ingested count + snapshot id
```

## Anti-drift (catastrophic forgetting)

See README "Anti-drift mechanisms" section. Key points:

1. **Append, never delete**: ingest has no "delete rule" authority.
2. **Three-tier abstraction**: core / secondary / candidate — promotion/demotion goes through review.
3. **Evidence counts**: each rule's frequency is recomputed from corpus-index, not manually maintained.
4. **Bucketed sampling**: `sample_corpus` rotates across topics to avoid bias from skewed corpus.
5. **Snapshot before every write**: auto-snapshot before write operations, with rollback support.
6. **CHANGELOG**: one line per write operation, timestamped.
7. **Small-sample warning**: `get_stats` explicitly declares frequencies unreliable when corpus < 15 entries.

## Path safety

MCPB does not enforce a sandbox — the server runs as the user with full filesystem access.

- All user-supplied paths are normalized via `path.resolve()`.
- Writes only happen under `$STYLEFORGE_HOME`; source file reads use user-given absolute paths (user has explicitly authorized them via ingest).
- Slug validation is strict: `^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$`, preventing directory traversal.

## Exit codes and errors

Tool calls return `{ isError: true }` rather than throwing exceptions, so the agent can continue. Common error forms:

```json
{ "error": "author 'xxx' not found" }
{ "error": "near-duplicates detected; re-run with allow_near=true or skip_near=true after user confirmation",
  "plan": { ... } }
{ "error": "delete_author requires confirm=true" }
```

`isError` lets the agent know this is an error to present/query the user; `plan` lets the agent proceed without re-calling.
