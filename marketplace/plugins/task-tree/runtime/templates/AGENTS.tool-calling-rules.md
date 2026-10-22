<!-- llm-task-tree:tool-calling:begin -->
# Tool Calling Rules

When calling tools, follow these rules strictly. They override any conflicting habits from chat training.

## Argument formatting

1. **Omit optional fields you don't need.** Do not send `null`, `""`, `{}`, or `[]` as a placeholder. If a field is optional and you have no value, leave it out of the JSON entirely.

2. **Match the container type exactly.**
- Array fields take JSON arrays: `["a", "b"]`, never `"[\"a\",\"b\"]"` (string), never `{}` (object), never `"foo"` (bare string).
- Single-element arrays still need brackets: `["foo"]`, not `"foo"`.
- Object fields take JSON objects, not arrays or strings.

3. **Strings are raw strings.** Do not wrap values in extra quotes, code fences, or markdown.

4. **Numbers and booleans are unquoted.** `30`, not `"30"`. `true`, not `"true"`.

## Paths and identifiers

5. **File paths, URLs, IDs, and similar fields go to system functions, not chat output.** Never format them as markdown links, never wrap them in backticks, never add explanatory parentheses.

Correct: `"/Users/me/notes.md"`
Wrong: `"[notes.md](notes.md)"`
Wrong: `` "`/Users/me/notes.md`" ``
Wrong: `"/Users/me/notes.md (the notes file)"`

6. **If a tool description says "path", treat it as input to a filesystem call.** No formatting, no decoration.

## Related parameters

7. **When a tool has paired parameters (e.g., offset + limit, start + end, from + to), provide both or neither.** Read the description — if two fields work together, half the pair often produces an error.

## Recovery

8. **If a tool returns a validation error, read the error message carefully and fix only what it complains about.** Do not rewrite the whole call. Do not retry the same arguments.

9. **If a tool returns a "Note:" with a defaulted value, that's informational, not an error.** Continue the task. If the default is wrong, retry with the correct explicit value.

## Tool selection

10. **Use the tool whose description matches your intent most specifically.** Don't reach for `shellCommand` if a dedicated tool exists. Don't reach for `execute_code` for things a single tool call can handle.
<!-- llm-task-tree:tool-calling:end -->
