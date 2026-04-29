# Styleforge

Per-author **writing-style management** as a Claude Code plugin. Works with any language. Incremental corpus ingestion, full rollback support, auto-triggering skill.

## Install

### Step 1 — Install the plugin (slash commands + skill)

```bash
claude plugin marketplace add coding-commits/styleforge
claude plugin install styleforge@styleforge
```

### Step 2 — Install dependencies & register the MCP server

The plugin marketplace installs slash commands and the auto-triggering skill, but
the MCP server (which provides the actual tools like `list_authors`,
`get_writing_guide`, etc.) needs to be registered separately:

```bash
# Install Node dependencies (required once)
cd ~/.claude/plugins/marketplaces/styleforge && npm install && cd -

# Register the MCP server globally
claude mcp add -s user styleforge -e STYLEFORGE_HOME=~/.styleforge -- node ~/.claude/plugins/marketplaces/styleforge/server/index.js
```

Then restart Claude Code (close and reopen your terminal).

> **Why two steps?** The plugin system handles skills and slash commands.
> The MCP server is a separate stdio process that must be registered so
> Claude Code can call its tools. Without Step 2, commands like
> `/style-write` will fire but the underlying tools won't be available.

## Upgrade

```bash
claude plugin marketplace update styleforge
claude plugin update styleforge@styleforge

# Re-install dependencies after upgrade
cd ~/.claude/plugins/marketplaces/styleforge && npm install && cd -
```

Then restart Claude Code.

After install you get:

- `/style-write` — Write in an author's style
- `/style-ingest` — Ingest new corpus articles
- `/style-feedback` — Digest feedback into learned-rules
- `/style-rollback` — Interactive rollback to a previous snapshot
- `/style-authors` — List all registered authors
- `/style-stats` — Show corpus statistics

Plus an auto-triggering **skill** — just say "write like hbdxsl" or "ingest these articles" and Claude handles the rest.

## Usage

**Write in an author's style:**
```
/style-write
> Write a short essay about the Song dynasty in hbdxsl's style
```

**Ingest new corpus** (local file paths only):
```
/style-ingest
> Ingest all .txt files in ~/Documents/hbdxsl-articles/
```

**Natural language** (skill auto-triggers):
```
Write like hbdxsl about modern education
Show stats for hbdxsl
List all styleforge authors
```

## Repo Structure

```
styleforge/
├── .claude-plugin/
│   └── plugin.json         # Plugin metadata
├── .mcp.json               # Auto-registers MCP server
├── commands/               # /style-* slash commands
├── skills/
│   └── styleforge/
│       └── SKILL.md        # Auto-triggering skill
├── server/
│   ├── index.js            # MCP server (17 tools, 6 prompts)
│   └── core/               # Business logic
├── package.json
└── docs/
```

## How It Works

```
       ┌──────────────────────────┐
       │    LLM (semantic work)   │
       └──────────┬───────────────┘
                  │ MCP protocol (local stdio)
       ┌──────────▼───────────────┐
       │  styleforge MCP server   │
       │   • 17 tools             │
       │   • 6 prompts            │
       └──────────┬───────────────┘
                  │
       ┌──────────▼───────────────┐
       │   ~/.styleforge/         │
       │     authors/<slug>/      │
       └──────────────────────────┘
```

- **LLM** handles understanding: extracting style patterns, judging rule promotion, tagging topics
- **Server** handles persistence: hashing, dedup, statistics, snapshots, changelog

## Tools

| Tool | Purpose |
|---|---|
| `list_authors` / `create_author` / `delete_author` | Author management |
| `get_writing_guide` | Full writing guide (overlay + patterns + rules) |
| `sample_corpus` | Topic-bucketed sampling |
| `ingest_dryrun` / `ingest_execute` | Safe ingestion (auto-dedup + snapshot) |
| `record_pattern_evidence` / `append_observation` | Pattern annotation |
| `recompute_stats` / `get_stats` | Statistics |
| `create_snapshot` / `list_snapshots` / `rollback` | Snapshots & rollback |
| `record_feedback` / `get_feedback_log` / `apply_learned_rule` | Feedback loop |

## Data

All data at `~/.styleforge/` (configurable via `$STYLEFORGE_HOME`). Each author is fully isolated:

```
~/.styleforge/authors/hbdxsl/
├── corpus/              # Source texts (append-only)
├── corpus-index.json    # Hashes, topics, pattern evidence
├── style-patterns.md    # Style rules with evidence counts
├── observations.md      # Candidate patterns
├── learned-rules.md     # Rules from feedback
├── overlay.md           # Per-author preferences
└── snapshots/           # Timestamped state snapshots
```

## Uninstall

```bash
claude mcp remove -s user styleforge
claude plugin remove styleforge@styleforge
```

To also remove data: `rm -rf ~/.styleforge`

## License

GPL-3.0-or-later
