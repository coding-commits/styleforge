// Author management: directory layout, slugs, metadata.
// Each author lives under <root>/authors/<slug>/ and is fully isolated.

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

import { writeJsonAtomic, writeTextAtomic, readJson, expandHome } from "../io/atomic.js";

// Slug must be filesystem-safe and shell-friendly.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/;

export function defaultRoot() {
  // Order: $STYLEFORGE_HOME (set by mcpb manifest from user_config), then ~/.styleforge.
  const env = process.env.STYLEFORGE_HOME;
  if (env && env.trim() !== "") {
    return path.resolve(expandHome(env));
  }
  return path.join(os.homedir(), ".styleforge");
}

export function authorsDir(root) {
  return path.join(root || defaultRoot(), "authors");
}

export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

/**
 * Build the canonical set of paths for one author.
 * Stateless — construct once, use many times.
 */
export class AuthorPaths {
  constructor(slug, root) {
    if (!isValidSlug(slug)) {
      throw new Error(`invalid slug ${JSON.stringify(slug)}: must match ${SLUG_RE}`);
    }
    this.slug = slug;
    this.root = root || defaultRoot();
    this.base = path.join(authorsDir(this.root), slug);
  }

  // top-level
  get meta()       { return path.join(this.base, "meta.json"); }
  get overlay()    { return path.join(this.base, "SKILL_OVERLAY.md"); }
  get changelog()  { return path.join(this.base, "CHANGELOG.md"); }

  // corpus
  get corpusDir()    { return path.join(this.base, "corpus"); }
  get corpusIndex()  { return path.join(this.base, "corpus-index.json"); }

  // patterns / observations
  get stylePatterns() { return path.join(this.base, "style-patterns.md"); }
  get observations()  { return path.join(this.base, "observations.md"); }

  // annotated samples
  get annotatedDir()  { return path.join(this.base, "annotated"); }

  // examples
  get examplesGood()  { return path.join(this.base, "examples", "good"); }
  get examplesBad()   { return path.join(this.base, "examples", "bad"); }

  // feedback
  get feedbackLog()   { return path.join(this.base, "feedback", "log.md"); }
  get learnedRules()  { return path.join(this.base, "feedback", "learned-rules.md"); }

  // drafts (style-write output)
  get draftsDir()     { return path.join(this.base, "drafts"); }

  // snapshots
  get snapshotsDir()  { return path.join(this.base, "snapshots"); }
}

export async function listAuthors(root) {
  const base = authorsDir(root);
  let children;
  try {
    children = await fs.readdir(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!child.isDirectory()) continue;
    const metaPath = path.join(base, child.name, "meta.json");
    const data = await readJson(metaPath);
    if (!data) continue;
    out.push(data);
  }
  return out;
}

export async function getAuthor(slug, root) {
  if (!isValidSlug(slug)) return null;
  const paths = new AuthorPaths(slug, root);
  return await readJson(paths.meta);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export async function createAuthor({ slug, displayName, description = "", root }) {
  const paths = new AuthorPaths(slug, root);
  const exists = await fs.stat(paths.base).then(() => true).catch(() => false);
  if (exists) {
    const err = new Error(`author ${JSON.stringify(slug)} already exists at ${paths.base}`);
    err.code = "EEXIST";
    throw err;
  }

  const meta = {
    slug,
    display_name: displayName,
    description,
    created_at: nowIso(),
  };

  for (const d of [
    paths.base,
    paths.corpusDir,
    paths.annotatedDir,
    paths.examplesGood,
    paths.examplesBad,
    path.dirname(paths.feedbackLog),
    paths.draftsDir,
    paths.snapshotsDir,
  ]) {
    await fs.mkdir(d, { recursive: true });
  }

  await writeJsonAtomic(paths.meta, meta);
  await writeJsonAtomic(paths.corpusIndex, {
    version: 1,
    entries: [],
    patterns_evidence: {},
  });

  await writeTextAtomic(
    paths.stylePatterns,
    `# ${displayName} · 风格规则\n\n` +
      "本文件由 styleforge 维护。每条规则附证据计数,基于 corpus-index.json 重算。\n" +
      "规则频次由 recompute_stats 从 corpus-index.json 自动计算。\n\n" +
      "## 0. 文风 ≠ 立场\n\n" +
      "仅复刻写作骨架与笔法,不复刻作者的政治观点或史观。用户当次给定的立场优先。\n\n" +
      "## 1. 候选核心规则(>=70% 频次)\n\n_(待累积更多语料)_\n\n" +
      "## 2. 候选次级规则(30%-70% 频次)\n\n_(尚无)_\n\n" +
      "## 3. 候选低频规则(<30% 频次)\n\n_(尚无)_\n\n" +
      "## 4. 必须避免的失败模式\n\n_(随反馈累积)_\n",
  );

  await writeTextAtomic(
    paths.observations,
    `# ${displayName} · 观察日志\n\n` +
      "模式观察记录。描述和例句供 style-patterns.md 生成时引用。\n\n",
  );

  await writeTextAtomic(
    paths.overlay,
    `# ${displayName} · 写作指导(overlay)\n\n` +
      "本文件由用户维护,与公共写作守则协同作用,补充该作者特有的写作约束。\n" +
      "每次 style-write 触发都会读取此文件。\n\n" +
      "## 立场约束\n\n" +
      "提醒 agent:本工具仅复刻文风,不复刻该作者的具体政治立场。\n" +
      "用户当次给定的立场优先于本文件中的任何隐含立场。\n\n" +
      "## 该作者特有的偏好\n\n_(待补充)_\n",
  );

  await writeTextAtomic(
    paths.feedbackLog,
    `# ${displayName} · 反馈日志\n\n` +
      "记录每次 agent 输出的问题点。累积后由 style-feedback 归纳。\n\n",
  );

  await writeTextAtomic(
    paths.learnedRules,
    `# ${displayName} · 已习得修正\n\n` +
      "由 style-feedback 流程从反馈中归纳出的修正规则。style-write 在写作前读取本文件。\n\n",
  );

  await writeTextAtomic(
    paths.changelog,
    `# ${displayName} · CHANGELOG\n\n` +
      `## ${meta.created_at}\n` +
      `- action: create_author\n` +
      `- slug: ${slug}\n` +
      `- display_name: ${displayName}\n\n`,
  );

  return meta;
}

export async function deleteAuthor(slug, root) {
  const paths = new AuthorPaths(slug, root);
  const exists = await fs.stat(paths.base).then(() => true).catch(() => false);
  if (!exists) {
    const err = new Error(`author ${JSON.stringify(slug)} not found`);
    err.code = "ENOENT";
    throw err;
  }
  await fs.rm(paths.base, { recursive: true, force: true });
}
