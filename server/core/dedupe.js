// Deduplication: exact (SHA-256) and near-duplicate (SimHash + Hamming).
//
// Same design as the original Python module:
// 1. Exact match first (cheap, catches accidental re-uploads).
// 2. Near-duplicate fallback: take an adaptive slice from the document
//    middle, compute SimHash, compare with the corpus by Hamming distance.
//    Multiple slice attempts so first-slice misses get a second chance.
//
// We do NOT decide what to do with duplicates. That is a policy decision
// (skip / replace / emphasize) made by the caller, who in turn asks the user.
//
// Implementation note: JS bitwise ops are 32-bit. We do SimHash as a 64-bit
// value using BigInt to avoid sign/overflow surprises. SHA-256 is via the
// standard `crypto` module.

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

export function sha256OfText(text) {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

export function sha256OfBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// SimHash
// ---------------------------------------------------------------------------

function normalizeText(text) {
  // Strip whitespace runs. Conservative on purpose; aggressive normalization
  // erases the differences that distinguish a revision from a duplicate.
  return text.replace(/\s+/g, "");
}

function shingle(text, n = 5) {
  // Character n-grams. For Chinese, char-level shingling is natural and
  // language-agnostic — no need to tokenize.
  if (text.length < n) return text ? [text] : [];
  const out = [];
  for (let i = 0; i <= text.length - n; i++) {
    out.push(text.slice(i, i + n));
  }
  return out;
}

function hash64(s) {
  // Stable 64-bit hash of a string using SHA-256 truncated to 8 bytes.
  // Returns a BigInt.
  const digest = crypto.createHash("sha256").update(s, "utf-8").digest();
  // Take first 8 bytes, big-endian unsigned.
  let n = 0n;
  for (let i = 0; i < 8; i++) {
    n = (n << 8n) | BigInt(digest[i]);
  }
  return n;
}

export function simhash(text, n = 5) {
  const norm = normalizeText(text);
  const shingles = shingle(norm, n);
  if (shingles.length === 0) return 0n;

  // Each bit position accumulates +1/-1 across all shingle hashes.
  const counts = new Array(64).fill(0);
  for (const sh of shingles) {
    const h = hash64(sh);
    for (let bit = 0; bit < 64; bit++) {
      if ((h >> BigInt(bit)) & 1n) counts[bit]++;
      else counts[bit]--;
    }
  }

  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (counts[bit] > 0) out |= 1n << BigInt(bit);
  }
  return out;
}

export function hamming(a, b) {
  // a, b: BigInts. Count set bits in XOR.
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    if (x & 1n) count++;
    x >>= 1n;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Adaptive slicing
// ---------------------------------------------------------------------------

function sliceForFingerprint(text, attempt = 0, sliceLen = 500) {
  // Focus on the middle 50% of the document to skip title/header noise.
  // First attempt: first sliceLen chars of that band. Subsequent attempts
  // walk further in. Returns null if attempt is past the band's end.
  const norm = normalizeText(text);
  const L = norm.length;
  if (L === 0) return null;

  const midStart = Math.floor(L / 4);
  const midEnd = Math.floor((3 * L) / 4);
  const band = norm.slice(midStart, midEnd);
  if (!band) {
    // Doc too short for middle-band sampling.
    return attempt === 0 ? norm.slice(0, sliceLen) : null;
  }
  const offset = attempt * sliceLen;
  if (offset >= band.length) return null;
  return band.slice(offset, offset + sliceLen);
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

export function fingerprintText(text, maxAttempts = 3) {
  const sha = sha256OfText(text);
  const hashes = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slice = sliceForFingerprint(text, attempt);
    if (slice === null) break;
    hashes.push(simhash(slice));
  }
  if (hashes.length === 0) {
    // Fallback for very short docs.
    hashes.push(simhash(text));
  }
  return { sha, simhashes: hashes };
}

/**
 * Check candidateText against an iterable of corpus fingerprints.
 *
 * @param {string} candidatePath - filesystem path of candidate
 * @param {string} candidateText - file content
 * @param {Array<{entryId, path, sha256, simhashes}>} corpus
 *        simhashes are BigInt[]
 * @param {object} opts
 * @returns {Array<{candidatePath, matchedId, matchedPath, kind, distance, attempt}>}
 */
export function findDuplicates(candidatePath, candidateText, corpus, { hammingThreshold = 6 } = {}) {
  const { sha: candSha, simhashes: candHashes } = fingerprintText(candidateText);
  const matches = [];

  for (const entry of corpus) {
    if (entry.sha256 === candSha) {
      matches.push({
        candidatePath,
        matchedId: entry.entryId,
        matchedPath: entry.path,
        kind: "exact",
        distance: 0,
        attempt: 0,
      });
      continue;
    }
    let best = null;
    for (let attempt = 0; attempt < candHashes.length; attempt++) {
      for (const stored of entry.simhashes) {
        const d = hamming(candHashes[attempt], stored);
        if (d <= hammingThreshold) {
          if (best === null || d < best.distance) {
            best = { distance: d, attempt };
          }
        }
      }
    }
    if (best !== null) {
      matches.push({
        candidatePath,
        matchedId: entry.entryId,
        matchedPath: entry.path,
        kind: "near",
        distance: best.distance,
        attempt: best.attempt,
      });
    }
  }
  return matches;
}

// Helpers for serializing simhashes to/from JSON (BigInt -> string).
export function simhashesToJson(hashes) {
  return hashes.map((h) => h.toString());
}

export function simhashesFromJson(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => BigInt(s));
}
