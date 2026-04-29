// Pattern frequency recomputation and bucketed sampling.
//
// Every pattern's "evidence count" is derived from corpus-index.json's
// pattern_ids field. We never store the count directly — it would drift.

import { loadIndex, saveIndex } from "./corpus.js";

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
  return stats;
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
