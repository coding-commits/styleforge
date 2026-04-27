# 架构

## 三层结构

styleforge 是一个 MCP server,运行在用户机器上,通过 stdio 与 Claude Desktop 通信。

```
Claude Desktop  ⇄  styleforge MCP server  ⇄  filesystem
                   (Node.js, stdio)         (~/.styleforge/)
```

## 工具与 Prompts 的边界

styleforge 同时暴露两种 MCP capability:

**Tools** 做事——它们是函数,接受参数,返回数据。
**Prompts** 给指令——它们是流程模板,被用户(以 slash command 方式)或客户端调用,展开成一段引导 agent 的文本。

在 styleforge 里:

| 场景 | 工具承载 | Prompt 承载 |
|---|---|---|
| 列作者 | `list_authors` | — |
| 拿到该作者完整写作指导 | `get_writing_guide` | — |
| 走完一次写作流程 | — | `/style-write` |
| 走完一次语料吸收流程 | — | `/style-ingest` |

Prompt 里不写具体逻辑,它只告诉 agent:"先调 X,然后调 Y,中间问用户 Z"。具体动作都在工具里。

## 为什么 LLM 与确定性逻辑要严格分开

| 任务 | 谁做 | 原因 |
|---|---|---|
| 读懂文章风格亮点 | LLM | 需要语义理解 |
| 给文章打主题标签 | LLM | 需要语义理解 |
| 评判规则升降级 | LLM + 用户 | 需要判断 |
| 计算文件 SHA-256 | Server | 确定性、零 token |
| 检测近似重复(SimHash) | Server | 确定性、零 token |
| 维护快照 | Server | 不能漏、不能错 |
| 重算频次 | Server | 容易数错,自动化更可靠 |
| 写 CHANGELOG | Server | 必须每次都写 |

LLM 做的事:**需要"读懂"**;Server 做的事:**需要"算对、记牢"**。

## 数据目录

每个作者完全隔离:

```
$STYLEFORGE_HOME/authors/hbdxsl/
├── meta.json              # slug, display_name, description, created_at
├── SKILL_OVERLAY.md       # 用户维护:该作者特有的写作约束
├── corpus/
│   └── 2026-02-03-xxx.txt # 原文(只追加,不修改)
├── corpus-index.json      # 结构化索引(机器读写)
├── style-patterns.md      # 规则总表(人/agent 读取,带证据计数)
├── observations.md        # 候选观察(未升格)
├── annotated/             # 带标注的范例(可选)
├── examples/{good,bad}/   # 输出归档
├── feedback/
│   ├── log.md             # 原始反馈
│   └── learned-rules.md   # 归纳出的修正
├── snapshots/
│   └── 2026-04-26T14-30-00/
│       ├── corpus-index.json
│       ├── style-patterns.md
│       ├── observations.md
│       ├── SKILL_OVERLAY.md
│       └── feedback/learned-rules.md
└── CHANGELOG.md
```

为什么 corpus-index 是 JSON 而不是 markdown:Server 频繁读写,要稳定可解析。
为什么 style-patterns 是 markdown:`get_writing_guide` 直接把它的文本给 agent。

## 写作流程示意

用户:"用 hbdxsl 写一段关于落日的小文"

```
agent 决定 → list_authors → 找到 hbdxsl
         → get_writing_guide(hbdxsl)  ← 这里返回 SKILL_OVERLAY+patterns+learned
         → sample_corpus(hbdxsl, k=2)  ← 可选,拿原文做参考
         → 起草                          ← LLM 工作
         → 自检 §4 失败模式
         → 交付
         → record_feedback(可选)
```

## 吸收语料流程

用户:"把这几篇加到 hbdxsl"

```
agent → list_authors                     ← 验证作者存在
     → ingest_dryrun(hbdxsl, [files])    ← 看会发生什么
     → 报告给用户
     → 用户确认                            ← 关键!特别是 near-duplicates
     → ingest_execute                     ← 真正写入,自动快照
     → for each new entry:
         view 文件                        ← LLM 读
         record_pattern_evidence          ← 写回 topics + pattern_ids
         (可能还要 append_observation)    ← 新发现的候选模式
     → recompute_stats
     → 报告 ingested 数 + snapshot id
```

## 防退化(catastrophic forgetting)

详见 README "防退化机制"一节。要点:

1. **追加而非删除**:ingest 没有"删除规则"权限。
2. **三层抽象**:核心 / 次级 / 候选 — 升降级走评审。
3. **证据计数**:每条规则的频次由 corpus-index 重算,不靠手工维护。
4. **分桶采样**:`sample_corpus` 按主题轮换,避免被偏移语料带跑。
5. **每写必快照**:写动作前自动快照,可回退。
6. **CHANGELOG**:每次写动作记一行,精确到时间。
7. **小样本警告**:`get_stats` 在语料 < 15 篇时主动声明频次不可靠。

## 路径安全

MCPB 不强制沙箱——server 以用户身份运行,有完整文件系统访问权。

- 所有用户提供的路径都经 `path.resolve()` 规范化。
- 写入只发生在 `$STYLEFORGE_HOME` 下;读源文件用用户给的绝对路径(用户已经通过 ingest 显式授权)。
- Slug 校验严格:`^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$`,避免目录穿越。

## 退出码与错误

工具调用返回 `{ isError: true }` 而非抛异常,这样 agent 能继续推进。常见错误形式:

```json
{ "error": "author 'xxx' not found" }
{ "error": "near-duplicates detected; re-run with allow_near=true or skip_near=true after user confirmation",
  "plan": { ... } }
{ "error": "delete_author requires confirm=true" }
```

`isError` 让 agent 知道这是错误并向用户呈现/询问;`plan` 让 agent 不需要再调用一次就能继续推进。
