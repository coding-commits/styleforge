// Append-only CHANGELOG. Each entry is a markdown section so both humans
// and agents can read it directly.

import { appendText } from "../io/atomic.js";

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export async function logAction(paths, action, { details = {}, snapshot = null } = {}) {
  const lines = [`\n## ${nowIso()}`, `- action: ${action}`];
  if (snapshot) lines.push(`- snapshot: ${snapshot}`);
  for (const [k, v] of Object.entries(details)) {
    let rendered;
    if (Array.isArray(v)) {
      rendered = v.length ? v.map(String).join(", ") : "(none)";
    } else {
      rendered = String(v);
    }
    lines.push(`- ${k}: ${rendered}`);
  }
  await appendText(paths.changelog, lines.join("\n") + "\n");
}
