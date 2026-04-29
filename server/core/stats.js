// Pattern frequency recomputation and bucketed sampling.
//
// Every pattern's "evidence count" is derived from corpus-index.json's
// pattern_ids field. We never store the count directly — it would drift.
//
// recomputeStats also regenerates style-patterns.md so the writing guide
// always reflects current frequencies.

import { loadIndex, saveIndex } from "./corpus.js";
import { readText, writeTextAtomic } from "../io/atomic.js";

export async function recomputeStats(paths) {
  const index = await loadIndex(paths.corpusIndex);
  const totalEntries = index.entries.length;
  const totalWeighted = index.entries.reduce((acc, e) => acc + (e.weight ?? 1), 0);

  const byPattern = new Map();
  for (const e of index.entries) {
    for (const pid of e.pattern_ids || []) {
      if (!byPattern.has(pid)) byPattern.set(pid, []);
      byPattern.get(pid).push(e);
    }
  }

  const stats = {};
  const evidence = {};
  for (const [pid, entries] of byPattern) {
    const raw = entries.length;
    const weighted = entries.reduce((acc, e) => acc + (e.weight ?? 1), 0);
    stats[pid] = {
      pattern_id: pid,
      raw_count: raw,
      weighted_count: weighted,
      total_entries: totalEntries,
      total_weighted: totalWeighted,
      frequency: totalWeighted > 0 ? weighted / totalWeighted : 0,
    };
    evidence[pid] = entries.map((e) => e.entry_id);
  }

  index.patterns_evidence = evidence;
  await saveIndex(paths.corpusIndex, index);

  // Regenerate style-patterns.md from current frequencies + observations.
  await regenerateStylePatterns(paths, stats);

  return stats;
}

/**
 * Rebuild style-patterns.md from computed stats + observations.md descriptions.
 * Observations provide the human-readable description/example for each pattern_id.
 */
async function regenerateStylePatterns(paths, stats) {
  // Parse observations.md to get descriptions for each pattern_id.
  const obsText = (await readText(paths.observations)) || "";
  const obsMap = parseObservations(obsText);

  // Read existing style-patterns.md to preserve §0 and §4 (hand-written sections).
  const existing = (await readText(paths.stylePatterns)) || "";
  const section0 = extractSection(existing, "## 0.") || "仅复刻写作骨架与笔法,不复刻作者的政治观点或史观。用户当次给定的立场优先。";
  const section4 = extractSection(existing, "## 4.") || "_(随反馈累积)_";

  // Get author display name from the header or fallback.
  const headerMatch = existing.match(/^# (.+?) · 风格规则/);
  const authorName = headerMatch ? headerMatch[1] : paths.slug;

  // Bucket patterns by frequency.
  const core = [];      // >=70%
  const secondary = []; // 30%-70%
  const lowFreq = [];   // <30%

  for (const [pid, s] of Object.entries(stats)) {
    const entry = { pattern_id: pid, frequency: s.frequency, count: s.raw_count, total: s.total_entries };
    if (s.frequency >= 0.7) core.push(entry);
    else if (s.frequency >= 0.3) secondary.push(entry);
    else lowFreq.push(entry);
  }

  // Sort each tier by frequency descending.
  const byFreqDesc = (a, b) => b.frequency - a.frequency;
  core.sort(byFreqDesc);
  secondary.sort(byFreqDesc);
  lowFreq.sort(byFreqDesc);

  function randomPick(arr) {
    if (arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function formatTier(entries) {
    if (entries.length === 0) return "_(尚无)_\n";
    return entries.map((e) => {
      const pct = Math.round(e.frequency * 100);
      const obs = obsMap.get(e.pattern_id);
      const desc = obs ? randomPick(obs.descriptions) || e.pattern_id : e.pattern_id;
      const example = obs ? randomPick(obs.examples) : null;
      const exLine = example ? `\n  - 例: ${example}` : "";
      return `### ${e.pattern_id}\n- 频次: ${pct}% (${e.count}/${e.total} 篇)${exLine}\n- ${desc}\n`;
    }).join("\n");
  }

  const output = [
    `# ${authorName} · 风格规则`,
    "",
    "本文件由 styleforge 维护。每条规则附证据计数,基于 corpus-index.json 重算。",
    "规则频次由 recompute_stats 从 corpus-index.json 自动计算。",
    "",
    "## 0. 文风 ≠ 立场",
    "",
    section0,
    "",
    "## 1. 候选核心规则(>=70% 频次)",
    "",
    formatTier(core),
    "## 2. 候选次级规则(30%-70% 频次)",
    "",
    formatTier(secondary),
    "## 3. 候选低频规则(<30% 频次)",
    "",
    formatTier(lowFreq),
    "## 4. 必须避免的失败模式",
    "",
    section4,
    "",
  ].join("\n");

  await writeTextAtomic(paths.stylePatterns, output);
}

/**
 * Parse observations.md into a Map<pattern_id, {descriptions: string[], examples: string[]}>.
 * Collects ALL observations for each pattern_id (does not overwrite).
 * Handles both well-formatted (## on its own line) and malformed
 * (## concatenated with previous line's timestamp) observations.
 */
function parseObservations(text) {
  const map = new Map();
  // Split on ## whether at line start or mid-line (malformed append).
  const sections = text.split(/(?:^|\n)## |(?<=\S)## /).slice(1);
  for (const section of sections) {
    const lines = section.split("\n");
    const id = lines[0].trim();
    let description = "";
    let example = "";
    for (const line of lines.slice(1)) {
      const m = line.match(/^- 描述:\s*(.+)/);
      if (m) { description = m[1]; continue; }
      const ex = line.match(/^- 例:\s*(.+)/);
      if (ex) { example = ex[1]; continue; }
    }
    if (!id) continue;
    if (!map.has(id)) map.set(id, { descriptions: [], examples: [] });
    const entry = map.get(id);
    if (description) entry.descriptions.push(description);
    if (example) entry.examples.push(example);
  }
  return map;
}

/**
 * Extract a section's body from style-patterns.md by its heading prefix.
 * Returns the text between this heading and the next ## heading.
 */
function extractSection(text, headingPrefix) {
  const idx = text.indexOf(headingPrefix);
  if (idx === -1) return null;
  const afterHeading = text.indexOf("\n", idx);
  if (afterHeading === -1) return null;
  const nextSection = text.indexOf("\n## ", afterHeading);
  const body = nextSection === -1
    ? text.slice(afterHeading + 1)
    : text.slice(afterHeading + 1, nextSection);
  return body.trim();
}

export async function bucketedSample(paths, { topic = null, k = 3, seed = null } = {}) {
  const index = await loadIndex(paths.corpusIndex);
  const entries = index.entries.slice();
  if (entries.length === 0) return [];

  const rng = makeRng(seed);

  if (topic) {
    const matches = entries.filter((e) => (e.topics || []).includes(topic));
    const rest = entries.filter((e) => !(e.topics || []).includes(topic));
    shuffle(matches, rng);
    shuffle(rest, rng);
    return [...matches, ...rest].slice(0, k);
  }

  const buckets = new Map();
  for (const e of entries) {
    const key = (e.topics && e.topics[0]) || "_untagged";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const keys = [...buckets.keys()];
  shuffle(keys, rng);
  for (const key of keys) shuffle(buckets.get(key), rng);

  const out = [];
  while (out.length < k && [...buckets.values()].some((arr) => arr.length > 0)) {
    for (const key of keys) {
      const arr = buckets.get(key);
      if (arr.length === 0) continue;
      out.push(arr.pop());
      if (out.length >= k) break;
    }
  }
  return out;
}

// Tiny seeded RNG (xorshift32) so seeded samples are reproducible.
function makeRng(seed) {
  if (seed === null || seed === undefined) {
    return () => Math.random();
  }
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
