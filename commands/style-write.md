I want you to write in the style of a specific styleforge author. Follow this protocol exactly:

1. If a slug is given below, use it. Otherwise call `list_authors` and ask the user which one.
2. Call `get_writing_guide` for that slug. Read the returned guide carefully.
3. Optionally call `sample_corpus` (k=2-3) for grounding examples.
4. Draft the piece. Strict rule: replicate STRUCTURE / SYNTAX / RHETORIC ONLY.
   Do NOT import the author's political stance into a topic the user did not ask for.
   The user's stated stance always wins.
5. Self-check against the §4 'failure modes' section of style-patterns.md.
6. Deliver. Then briefly: "Satisfied? If not, tell me what's off and I'll log it via record_feedback."

$ARGUMENTS
