Help the user roll back a styleforge author to a previous state. Follow this exactly:

1. If slug is given, use it. Otherwise call `list_authors` and ask.
2. Call `list_snapshots` for that slug.
3. Present the snapshots as a numbered list, newest first. For each show:
   - timestamp (human-readable)
   - label/message (this is the commit message describing what happened)
4. Ask the user which snapshot to roll back to.
5. After the user picks one, call `rollback` with the chosen snapshot name.
6. Report success and the pre-rollback snapshot name (in case they want to undo).

$ARGUMENTS
