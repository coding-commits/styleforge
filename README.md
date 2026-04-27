# Styleforge

为 Claude 维护**多个作者的中文写作风格**。一键安装(`.mcpb`)、按需扩充语料、误操作可回退。

## 安装(一行复制即可)

打开终端,粘贴这一行:

```bash
curl -L https://github.com/your-username/styleforge/releases/latest/download/styleforge.mcpb -o ~/Downloads/styleforge.mcpb && open ~/Downloads/styleforge.mcpb
```

(Windows 用户:在 PowerShell 里运行类似命令,然后双击下载到的 `.mcpb` 文件。)

Claude Desktop 会弹出"安装这个扩展吗?",点确认。装完之后:

- **安装时设置数据目录**:默认 `~/.styleforge/`,你可以改到任何路径(比如同步盘里),你的语料和快照都在这里。
- **不需要 npm,不需要 Python,不需要改任何配置文件**——`.mcpb` 自带运行所需的一切,Claude Desktop 内置 Node.js。

如果你没有 GitHub release(自己 build 的情况),把这个仓库 clone 下来,然后:

```bash
npm install
npx @anthropic-ai/mcpb pack .
# 生成 styleforge.mcpb,双击即可
```

## 启动后怎么用

打开 Claude Desktop,新建会话,试试这些:

**写作**:
```
/style-write hbdxsl 写一篇关于宋朝的小文
```

或自然语言触发:"用 hbdxsl 风格写一段关于落日的杂文。"

**喂入新语料**:
```
/style-ingest hbdxsl 把 ~/Documents/articles/ 下面这几篇加进来
```

**整理反馈**:
```
/style-feedback hbdxsl
```

或直接调用工具:"列出所有 styleforge 作者"、"显示 hbdxsl 的统计"等。

## 工作分工

```
       ┌──────────────────────────┐
       │  Claude (LLM 语义工作)   │
       └──────────┬───────────────┘
                  │ MCP 协议(本地 stdio)
       ┌──────────▼───────────────┐
       │  styleforge MCP server   │
       │   • tools(确定性工作)   │
       │   • prompts(快捷入口)   │
       └──────────┬───────────────┘
                  │
       ┌──────────▼───────────────┐
       │   $STYLEFORGE_HOME       │
       │     authors/<slug>/      │
       └──────────────────────────┘
```

LLM 做 *需要"读懂"* 的事:抽取风格亮点、判断规则升降、给文章打主题标签。
Server 做 *需要"算对、记牢"* 的事:哈希、去重、统计、快照、CHANGELOG。

## 提供的能力

**16 个工具**(MCP tools,Claude 按需调用):

| 工具 | 作用 |
|---|---|
| `list_authors` / `create_author` / `delete_author` | 作者管理 |
| `get_writing_guide` | **核心**:返回该作者的完整写作指导(SKILL_OVERLAY + style-patterns + learned-rules) |
| `sample_corpus` | 按主题分桶采样原文供 agent 参考 |
| `ingest_dryrun` / `ingest_execute` | 安全吸收语料(自动去重 + 自动快照) |
| `record_pattern_evidence` / `append_observation` | Agent 阅读后回写 topics 与 pattern_ids |
| `recompute_stats` / `get_stats` | 频次重算与展示 |
| `create_snapshot` / `list_snapshots` / `rollback` | 快照与回退 |
| `record_feedback` / `get_feedback_log` / `apply_learned_rule` | 反馈记录与消化 |

**3 个 slash command**(MCP prompts,用户输入 `/` 触发):

- `/style-write` — 在某作者风格下写作
- `/style-ingest` — 喂新语料(总是先 dry-run)
- `/style-feedback` — 整理累积反馈

每个 prompt 注入一段流程指令,告诉 agent 该按什么顺序调用哪些工具。

## 多作者隔离

每个作者完全独立的数据子树:

```
$STYLEFORGE_HOME/authors/
├── hbdxsl/        # 海边的西塞罗
├── lubin/         # 卢斌(假设)
└── ...
```

任何对作者 A 的操作都不读不写作者 B。

## 防退化机制

持续吸收新语料的过程中容易出现风格定义漂移、规则累积成噪音、统计基础消失等问题。styleforge 的对策:

| 风险 | 对策 |
|---|---|
| 新模式覆盖旧模式 | ingest 流程只追加,不删除;删除必须人工批准 |
| 语料偏移导致风格定义漂移 | 语料分桶,采样按桶轮换 |
| 规则累积变成噪音 | 三层结构(核心 / 次级 / 观察),累积到阈值触发评审 |
| 统计基础消失 | 每条规则证据计数从 corpus-index.json 重算 |
| 无法回滚 | 每次写动作前自动快照 + CHANGELOG 取证 + 三层回退命令 |
| 频次小样本误导 | 语料 < 15 篇时显式打 sample_warning 标签,所有规则均为 candidate |

## 误喂语料怎么办

```
"列出 hbdxsl 的快照"               → list_snapshots
"回退到 2026-04-26T14-29-58"        → rollback
```

或在 GUI 里手动看 `$STYLEFORGE_HOME/authors/<slug>/snapshots/`。

回退本身也会先快照当前状态,所以"回滚的回滚"也支持。

**注意**:rollback 只恢复 index 等小文件,**不删除 corpus/ 下的原文件**(这是有意为之的——原文是"原材料",对删除保持保守)。被 rollback 抛弃的文件成为"孤儿",索引中不再引用,但仍在磁盘上。

## 构建

```bash
git clone https://github.com/your-username/styleforge.git
cd styleforge
npm install
npm test                            # 运行核心模块的 smoke test
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . styleforge.mcpb
```

## 文档

- [架构](docs/architecture.md)
- [新增作者](docs/adding-an-author.md)
- [故障排查](docs/troubleshooting.md)

## License

MIT
