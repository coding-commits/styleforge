# Troubleshooting

## Accidentally ingested wrong corpus

```
/style-rollback hbdxsl
```

The agent will list all snapshots with timestamps and descriptive messages, then ask which one to restore.

Rollback itself takes a snapshot of the current state first (labeled `pre-rollback-...`), so "rollback the rollback" is always possible.

You can also inspect manually: `$STYLEFORGE_HOME/authors/<slug>/snapshots/`.

**Note**: rollback only restores `corpus-index.json` and other small files. It does **not** automatically delete files under `corpus/`. This is by design — source texts are "raw material" and deletion is kept conservative. If orphan files accumulate in corpus/ after rollback, they are harmless (not referenced in the index) but occupy disk space. To clean up manually:

```bash
ls $STYLEFORGE_HOME/authors/<slug>/corpus/    # see actual files
cat $STYLEFORGE_HOME/authors/<slug>/corpus-index.json | jq '.entries[].source_path'
# compare and delete orphans
```

A corpus garbage collection tool may be added in a future version.

## Article flagged as "near-duplicate" during ingestion

Possible causes:
- Same author revised an old article and republished, 80%+ content identical
- Different author copied/quoted the same long passage
- SimHash false positive (collision probability is low but non-zero)

Resolution (tell the agent in conversation):
- "Treat this as a new article" → agent will re-call with `allow_near=true`
- "Skip these near-duplicates" → agent will use `skip_near=true`
- "Raise the similarity threshold to 10" → agent will use `threshold=10` (default is 6)

## Style sampling always returns the same type of articles

Likely one topic dominates the corpus. Resolution:

```
"Show stats for hbdxsl"                      → get_stats (check topic distribution)
"Sample hbdxsl articles on history topic"    → sample_corpus topic="history"
```

Or proactively add corpus for underrepresented topics.

## Rule file got corrupted

```
/style-rollback hbdxsl
```

Or for a targeted restore: "Roll back, only restore style-patterns.md" → rollback with `only:["style-patterns.md"]`

## Stats show 100% frequency after ingest, but corpus is only a few articles

This is expected behavior, not a bug. "100% in 3 articles" only means "present in the seed corpus", not "universal author style" in a statistical sense. `get_stats` attaches a `sample_warning` field when entries < 15. Frequencies only become meaningful at 15+ articles.

## Accidentally deleted an author

After `delete_author`, the author directory is removed. **There is no undo** (snapshots were inside the deleted directory).

Prevention:
- Periodically back up `$STYLEFORGE_HOME` (rsync or git)
- Before deletion, `cp -r ...`

We deliberately don't add "soft delete" to the tool — it creates a false sense of safety and discourages backups.

## Moving data directory to another machine

```bash
# Source machine
tar czf styleforge-data.tar.gz -C $(dirname $STYLEFORGE_HOME) $(basename $STYLEFORGE_HOME)

# Target machine
tar xzf styleforge-data.tar.gz -C ~  # assuming default location
```

Alternatively: when installing styleforge, set data_dir to a cloud-synced folder (iCloud/Dropbox/OneDrive). Note that the snapshots directory will grow; watch your storage quota.

## Reinstall / upgrade styleforge

Upgrading the `.mcpb` does not affect `$STYLEFORGE_HOME` data. Just install the new version.

To change data directory: update styleforge's data_dir in your MCP client's extension settings, then manually move the `authors/` folder from the old path.

## Checking server logs

For Claude Desktop, extension logs are at:
- macOS: `~/Library/Logs/Claude/mcp*.log`
- Windows: `%APPDATA%\Claude\logs\mcp*.log`

Styleforge writes fatal errors to stderr, which appear in these logs. Other MCP clients may have different log locations — check your client's documentation.
