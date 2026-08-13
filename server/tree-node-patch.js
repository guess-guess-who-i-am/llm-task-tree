const FIELD_LINE = /^-\s+([A-Za-z]+):/;

function nodeSectionRange(lines, nodeId) {
  const escaped = String(nodeId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escaped}\\s+-`).test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s+\S+\s+-/.test(lines[end]) && !/^#\s+(GraphState|Edges)\b/.test(lines[end])) end += 1;
  return { start, end };
}

function renderFieldValue(field, value) {
  const text = String(value ?? "").replace(/\r/g, "");
  if (!text.includes("\n")) return [`- ${field}: ${text}`.trimEnd()];
  const parts = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return [`- ${field}:`, ...parts.map((line) => (line.startsWith("- ") ? `  ${line}` : `  - ${line}`))];
}

export function patchNodeFields(markdown, nodeId, fields) {
  const lines = String(markdown).replace(/\r/g, "").split("\n");
  const range = nodeSectionRange(lines, nodeId);
  if (!range) throw new Error(`任务树里没有节点 ${nodeId}`);
  const section = lines.slice(range.start, range.end);
  const applied = [];

  for (const [field, value] of Object.entries(fields || {})) {
    const at = section.findIndex((line) => new RegExp(`^-\\s+${field}:`).test(line));
    const rendered = renderFieldValue(field, value);
    if (at >= 0) {
      let stop = at + 1;
      while (stop < section.length && !FIELD_LINE.test(section[stop]) && section[stop].trim()) stop += 1;
      section.splice(at, stop - at, ...rendered);
    } else {
      let insertAt = section.findIndex((line) => /^-\s+SelectedSkills:/.test(line));
      if (insertAt < 0) {
        insertAt = section.length;
        while (insertAt > 0 && !section[insertAt - 1].trim()) insertAt -= 1;
      }
      section.splice(insertAt, 0, ...rendered);
    }
    applied.push(field);
  }

  lines.splice(range.start, range.end - range.start, ...section);
  return { markdown: lines.join("\n"), applied };
}
