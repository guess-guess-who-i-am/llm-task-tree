# Node Writing Policy

This policy applies whenever an Agent writes node prose in `task-tree.md` or `subtrees/*.md`. It overrides older examples in the frozen canonical protocol that ask for inline JSON, SQL, command output, or other raw samples.

## Language

- Write node titles, semantic fields, and edge explanations in concise Chinese by default.
- Familiar technical terms such as `LLM`, `token`, `API`, `MCP`, product names, model names, IDs, field names, file paths, and URLs may remain in their exact form when needed.
- Translate long or specialist English terminology into plain Chinese. In particular, do not place complex English medical, biological, legal, or other domain terminology in live nodes. Put the exact original term in an evidence file when retrieval or audit requires it.
- Avoid mixed Chinese-English prose when the English does not change identity or meaning.

## No Code In Nodes

- Do not paste source code, fenced code blocks, JSON, YAML, CSV rows, SQL, shell commands, formulas, stack traces, or raw logs into semantic node fields.
- `Input` and `Output` contain a short Chinese description of what is consumed or produced, plus optional file paths. They do not contain raw samples.
- `CodeLoc` may contain file paths, line numbers, and symbol names. Other fields may mention a necessary path or identifier, but must explain the conclusion in Chinese.
- Put exact code, commands, raw data, and detailed terminology in `scripts/steps/`, documents, source files, or other evidence artifacts. Keep only the decision-changing conclusion and a short pointer in the node.

## Goal-Relative CurrentResult

- Treat the user's explicit root goal, stage goal, and success definition as stable anchors. Do not replace them with a model-generated abstraction such as “the direction is correct”.
- `CurrentResult` directly answers the relevant goal in one compact status: what verified capability/evidence exists now, what remains missing, and therefore whether the goal can currently be claimed reached.
- Preserve the user's meaning even when wording is shortened. Numbers are optional evidence, not the definition of progress.
- A status containing only “已有进展”, “方向正确”, “基本完成”, or “仍需完善” is invalid because it does not tell the reader what state has actually been reached.

## Write Gate

Before writing, check each sentence:

1. Can an ordinary project reader understand it without decoding English jargon?
2. Is it a conclusion or constraint rather than raw evidence?
3. Does it avoid code-like syntax?
4. If this is `CurrentResult`, can the reader tell which user goal it answers, what is already true, what is still missing, and whether the goal is claimable now?

If any answer is no, rewrite it in Chinese or move it to evidence before calling `task_tree_write`.
