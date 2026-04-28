# Styleforge

**English** | [中文](README.zh-CN.md)

Per-author **writing-style management** for any MCP client. Works with any language. One-click install (`.mcpb`), incremental corpus ingestion, full rollback support.

## Install

### Claude Desktop (`.mcpb` one-click)

```bash
curl -L https://github.com/coding-commits/styleforge/releases/latest/download/styleforge.mcpb \
  -o ~/Downloads/styleforge.mcpb && open ~/Downloads/styleforge.mcpb
```

(Windows: use PowerShell, then double-click the downloaded `.mcpb` file.)

Claude Desktop will prompt to install. Slash commands (`/style-write`, etc.) work out of the box.

### Claude Code / other MCP clients

```bash
curl -sSL https://raw.githubusercontent.com/coding-commits/styleforge/main/install.sh | bash
```

This installs:
- **MCP server** (tools) → `~/.local/share/styleforge-mcp/`
- **Slash commands** → `~/.claude/commands/style-*.md`

After running, register the MCP server:

```bash
claude mcp add styleforge node ~/.local/share/styleforge-mcp/server/index.js -e STYLEFORGE_HOME=~/.styleforge
```

### Common notes

- **Data directory**: defaults to `~/.styleforge/`. Point it at a synced folder if you like — all corpus and snapshots live here.
- To build from source:

```bash
git clone https://github.com/coding-commits/styleforge.git && cd styleforge
npm install
npx @anthropic-ai/mcpb pack .  # produces styleforge.mcpb for Claude Desktop
```

## Usage

Open your MCP client, start a new chat:

**Write in an author's style**:
```
/style-write hbdxsl Write a short essay about the Song dynasty
```

**Ingest new corpus**:
```
/style-ingest hbdxsl Add the files in ~/Documents/articles/
```

**Process feedback**:
```
/style-feedback hbdxsl
```

**Roll back**:
```
/style-rollback hbdxsl
```

Or use natural language: "List all styleforge authors", "Show stats for hbdxsl", etc.

## Architecture

```
       ┌──────────────────────────┐
       │    LLM (semantic work)   │
       └──────────┬───────────────┘
                  │ MCP protocol (local stdio)
       ┌──────────▼───────────────┐
       │  styleforge MCP server   │
       │   • tools (deterministic)│
       │   • prompts (shortcuts)  │
       └──────────┬───────────────┘
                  │
       ┌──────────▼───────────────┐
       │   $STYLEFORGE_HOME       │
       │     authors/<slug>/      │
       └──────────────────────────┘
```

The LLM handles what requires *understanding*: extracting style highlights, judging rule promotion, tagging topics.
The server handles what must be *exact and persistent*: hashing, dedup, statistics, snapshots, changelog.

## Capabilities

**17 tools** (called by the LLM on demand):

| Tool | Purpose |
|---|---|
| `list_authors` / `create_author` / `delete_author` | Author management |
| `get_writing_guide` | **Core**: returns the full writing guide (SKILL_OVERLAY + style-patterns + learned-rules) |
| `sample_corpus` | Topic-bucketed sampling of source texts |
| `ingest_dryrun` / `ingest_execute` | Safe corpus ingestion (auto-dedup + snapshot + commit message) |
| `record_pattern_evidence` / `append_observation` | Record topics & pattern IDs after reading ingested articles |
| `recompute_stats` / `get_stats` | Frequency recomputation & display |
| `create_snapshot` / `list_snapshots` / `rollback` | Snapshots & rollback |
| `record_feedback` / `get_feedback_log` / `apply_learned_rule` | Feedback capture & digestion |

**7 slash commands** (MCP prompts):

- `/style-write` — Write in an author's style
- `/style-ingest` — Ingest new corpus (always dry-runs first)
- `/style-feedback` — Digest accumulated feedback into rules
- `/style-rollback` — Interactive rollback to a previous snapshot
- `/style-authors` — List all registered authors
- `/style-stats` — Show corpus statistics for an author

## Multi-author isolation

Each author is a fully isolated data subtree:

```
$STYLEFORGE_HOME/authors/
├── hbdxsl/
├── lubin/
└── ...
```

Operations on author A never read or write author B's data.

## Anti-drift mechanisms

| Risk | Mitigation |
|---|---|
| New patterns overwrite old | Ingest is append-only; deletion requires explicit approval |
| Corpus bias causes style drift | Bucketed sampling rotates across topics |
| Rules accumulate into noise | Three-tier structure (core / secondary / observation), review triggered at threshold |
| Statistical basis lost | Evidence counts recomputed from corpus-index.json |
| No undo | Auto-snapshot before every write + changelog + rollback command |
| Small-sample frequency misleading | Explicit `sample_warning` when corpus < 15 entries |

## Accidental ingestion?

```
/style-rollback hbdxsl
```

The agent lists all historical snapshots (with timestamps and descriptive messages), then asks you which one to restore. A fresh snapshot is always taken before rollback, so "rollback the rollback" works.

You can also inspect `$STYLEFORGE_HOME/authors/<slug>/snapshots/` manually.

**Note**: rollback restores index files only — it does **not** delete files under `corpus/` (by design: source texts are treated as immutable raw material).

## Build

```bash
git clone https://github.com/coding-commits/styleforge.git
cd styleforge
npm install
npm test                            # smoke test core modules
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . styleforge.mcpb
```

## Docs

- [Architecture](docs/en/architecture.md)
- [Adding an author](docs/en/adding-an-author.md)
- [Troubleshooting](docs/en/troubleshooting.md)

## License

GPL-3.0-or-later
