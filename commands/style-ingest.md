Ingest articles into a styleforge author's corpus. Follow this exactly:

1. Confirm the author exists via `list_authors`. If slug missing, ask.
2. Resolve file paths. If user pasted text, save each as a separate .txt under a sensible name first.
3. **Batch limit: 5 files**. Split larger batches and walk each through the full flow.
4. Call `ingest_dryrun`. Show the user: new_files / exact_duplicates / near_duplicates.
   If near_duplicates exist, ask explicitly: (a) treat as new, (b) skip, (c) cancel.
5. After confirmation, call `ingest_execute`. **Important**: pass a `message` parameter
   summarizing what was ingested (e.g. 'ingest 3 articles about Song dynasty history').
   This message is stored with the snapshot so the user can identify it later during rollback.
6. **Enrichment (critical)**: for each new entry, view the source file, then call
   `record_pattern_evidence` with topics + pattern_ids. Pull pattern_ids from the
   author's existing style-patterns.md (call `get_writing_guide`). Novel patterns
   go through `append_observation`, not record_pattern_evidence.
7. Call `recompute_stats`.
8. Report: ingested count, snapshot id, rollback hint.

$ARGUMENTS
