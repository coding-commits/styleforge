# HANDOFF: Build styleforge.mcpb

You are receiving a complete, tested Node.js MCP server. Your job: install
dependencies, package it as a `.mcpb`, and (optionally) publish a one-click
install URL.

The previous agent built and tested everything except the final packaging step,
which requires network access to `npm install`. That's the only thing left.

---

## 0. What you're working with

```
styleforge-mcp/
├── manifest.json              ← MCPB manifest (version 0.4)
├── package.json
├── README.md
├── docs/{architecture,adding-an-author,troubleshooting}.md
├── corpus_seed/*.txt          ← three sample articles for testing
└── server/
    ├── index.js               ← MCP server entry point
    ├── io/atomic.js
    ├── core/{author,changelog,corpus,dedupe,ingest,snapshot,stats}.js
    ├── smoke-test.js          ← exercises core modules without SDK
    └── verify-handlers.js
```

Everything in `server/core/` and `server/io/` has been smoke-tested:
**38 passed, 0 failed**. You don't need to touch that code unless the test
suite breaks. Just run it once to confirm.

The `server/index.js` is the MCP server bootstrap. It imports
`@modelcontextprotocol/sdk`, which is the only third-party dependency.
You need to `npm install` to get it.

---

## 1. Setup (5 min)

```bash
unzip styleforge-mcp-source.zip
cd styleforge-mcp

# Install dependencies — this is what the prior agent could not do.
npm install

# Verify core logic still passes
STYLEFORGE_HOME=/tmp/styleforge-test node server/smoke-test.js
# Expected: "38 passed, 0 failed"

# Verify server boots without crashing.
# This will block on stdio waiting for MCP messages — kill it after 2 seconds.
STYLEFORGE_HOME=/tmp/styleforge-boot timeout 2 node server/index.js
# Expected: exits with code 124 (timeout), no errors on stderr.
# If you see a stack trace, debug before proceeding.
```

If `npm install` complains about anything other than `@modelcontextprotocol/sdk`,
something has drifted — check the manifest's package.json against the latest
SDK release.

---

## 2. Validate manifest

```bash
npx @anthropic-ai/mcpb validate manifest.json
```

Expected: no errors. The manifest declares 17 tools, 3 prompts,
manifest_version 0.4, server type `node`, entry `server/index.js`. If
validation fails, there's a schema mismatch — read the error and fix in
`manifest.json`.

---

## 3. Pack the bundle

```bash
npx @anthropic-ai/mcpb pack . styleforge.mcpb
```

This zips the directory (including `node_modules/`) and validates everything.
Output: `styleforge.mcpb` in the current directory, typically 1–3 MB.

Test it locally before publishing:

1. Open Claude Desktop → Settings → Extensions → Advanced → Install Extension
2. Pick `styleforge.mcpb`
3. When prompted for `data_dir`, pick `~/.styleforge` (or any folder)
4. Restart Claude Desktop if needed
5. In a new chat: type `/style-write` — slash command should auto-complete
6. Try: "List all styleforge authors" — should call `list_authors` and return `[]`
7. Try: "Create a styleforge author with slug `test`, display name `Test`" —
   should succeed and the data dir should now have `authors/test/`

If any of those fail, look at Claude Desktop's MCP log:
- macOS: `~/Library/Logs/Claude/mcp*.log`
- Windows: `%APPDATA%\Claude\logs\mcp*.log`

---

## 4. Publish for one-click install

The final user experience the human asked for is:

> "给用户一条可以直接复制的命令完成安装"

Achieve this by publishing `styleforge.mcpb` as a GitHub release asset:

```bash
git init styleforge && cd styleforge
# Copy all files from styleforge-mcp/ into here
git add . && git commit -m "Initial commit"
git remote add origin git@github.com:YOUR_USERNAME/styleforge.git
git push -u origin main

# Create a release
gh release create v0.1.0 styleforge.mcpb --title "Styleforge 0.1.0" \
  --notes "First release"
```

The one-line install command then becomes:

```bash
curl -L https://github.com/YOUR_USERNAME/styleforge/releases/latest/download/styleforge.mcpb \
  -o ~/Downloads/styleforge.mcpb && open ~/Downloads/styleforge.mcpb
```

(On Windows: replace `open` with `start`.)

After running this, Claude Desktop pops up an install dialog automatically.
Update the `homepage` field in `manifest.json` to point at your repo before packing.

---

## 5. Restore the seed data (optional but recommended)

There's a separate zip `hbdxsl-seed-data.zip` containing a fully populated
`hbdxsl` author directory (3 articles, enriched with topic tags and pattern
evidence). After installing the `.mcpb`, the user can drop this into their
data dir to immediately have a working author:

```bash
unzip hbdxsl-seed-data.zip -d ~/.styleforge/authors/
ls ~/.styleforge/authors/hbdxsl/
# Should show: meta.json, corpus/, corpus-index.json, style-patterns.md, etc.
```

Alternatively the user can ingest the three seed `.txt` files manually via
`/style-ingest`.

---

## 6. Things to watch for

**MCP SDK version compatibility.** `package.json` requires `^1.0.0`. If a
new major version drops, the `setRequestHandler` API may have changed. The
file using it is `server/index.js` lines ~470–510. Check the SDK's CHANGELOG
if anything errors out at boot.

**The `mcpb` CLI itself.** It was renamed from `dxt` in late 2025. If
`npx @anthropic-ai/mcpb` fails with "package not found", try `@anthropic-ai/dxt`
as a fallback — it's the same tool under the old name.

**Claude Desktop version.** The manifest says `claude_desktop: ">=0.10.0"`,
which is a guess. If the user has a much older version, install fails with a
compatibility error. Either upgrade Claude Desktop or relax the constraint.

**Path traversal.** The server runs with full user privileges. It validates
slugs strictly but trusts user-supplied source paths to `ingest` (which is
correct — the user explicitly authorized them). Don't add code that takes
unvalidated paths from tool *output* and feeds them back into reads.

**Sample warning.** `get_stats` emits `sample_warning` when `entries < 15`.
This is intentional — the writing-guide tells the agent that frequencies on
small corpora are not statistically meaningful. Don't remove it.

---

## 7. The decision history (so you understand the choices)

- **Why Node, not Python?** Anthropic's official guidance: Python's MCP SDK
  uses pydantic, which has C extensions that don't bundle portably. Node ships
  inside Claude Desktop.
- **Why is "skill content" a tool, not a file?** MCP can't ship instruction
  files to Claude. So the writing guide is fetched on demand via
  `get_writing_guide` and naturally enters the agent's context. Slash commands
  (`/style-write`, etc.) are MCP prompts that inject a flow protocol —
  shortcuts to the same outcome.
- **Why two layers (corpus-index.json + style-patterns.md)?** The first is
  machine-readable structured state. The second is what the agent reads.
  Frequencies in style-patterns.md are recomputed from corpus-index, never
  hand-edited.
- **Why no auto-promotion of observations to rules?** Small samples lie. A
  pattern appearing in all 3 of 3 articles is "100% frequency" but means
  almost nothing. Promotion stays manual until the user reviews observations
  with 15+ articles in the corpus.

---

## 8. If you change the tool surface

Server's `TOOLS` array (in `server/index.js`) and manifest's `tools` array
(in `manifest.json`) MUST stay in sync — the bundle validator checks this.
Same for prompts: `PROMPTS` object in server vs `prompts` array in manifest.

Current count: **17 tools, 3 prompts**.

---

## 9. Smoke test what changed

After any code change:

```bash
STYLEFORGE_HOME=/tmp/styleforge-fresh node server/smoke-test.js
```

Should report `38 passed, 0 failed`. If it doesn't, you've broken something —
don't pack until it does.

For end-to-end verification against seed data:

```bash
# After installing the bundle and restoring hbdxsl seed:
STYLEFORGE_HOME=~/.styleforge node server/verify-handlers.js
```

This exercises every tool handler against real seeded data, prints
list_authors output, the writing guide preview, get_stats with the
sample_warning, sample_corpus output, and list_snapshots.

Good luck.
