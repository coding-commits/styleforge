Process accumulated feedback for a styleforge author. Follow this exactly:

1. Call `list_authors` and confirm the slug. If missing, ask.
2. Call `get_feedback_log` to read all entries.
3. Call `create_snapshot` with label `pre-feedback-review`.
4. Group recurring failure modes. Single occurrences are weak candidates.
   Contradictory feedback should be SHOWN to the user, not auto-resolved.
5. Present a numbered list of proposed learned-rules. For each:
   trigger / corrective_action / source_feedback / confidence.
6. Wait for user accept/reject/edit on each.
7. For each accepted (or user-edited) proposal, call `apply_learned_rule` with the
   final wording.
8. Briefly report: K accepted, K rejected, snapshot id for rollback.

Never: modify style-patterns.md directly, accept proposals without confirmation,
or strip original feedback log entries.

$ARGUMENTS
