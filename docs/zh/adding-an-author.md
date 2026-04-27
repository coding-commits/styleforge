# 新增一个作者

## 1. 通过对话创建

最自然的方式:在 Claude 里说

> 在 styleforge 里创建一个新作者,slug 叫 `lubin`,显示名"卢斌"。

Claude 会调 `create_author`。

## 2. Slug 规则

- 全小写字母 + 数字 + 连字符 + 下划线
- 长度 2-32
- 用作工具调用和 `/style-write <slug>` 这种快捷命令的标识

例:`hbdxsl`、`lubin`、`zhang-3`

## 3. 准备初始语料

至少准备 5 篇代表性文章,**理想情况下 15 篇以上**。少于 15 篇时,`get_stats` 会附带 sample_warning,所有规则被视为 candidate。

文章建议:
- 跨主题(不要全是同一类话题)
- 跨时段(不同时期可能反映风格演变)
- 文件命名:`YYYY-MM-DD-<short-name>.txt` 这种格式便于排序和定位

## 4. 喂入语料

```
/style-ingest lubin
```

或自然语言:"把 ~/Documents/lubin/2026/*.txt 加到 lubin 的语料"。

`/style-ingest` prompt 会带 agent 走完整流程:`ingest_dryrun` → 用户确认 → `ingest_execute` → 富化(每篇调一次 `record_pattern_evidence`)→ `recompute_stats`。

## 5. 富化是关键步骤

`ingest_execute` 完成后,corpus-index.json 里的新 entry 还没有 `topics` 和 `pattern_ids`。**必须**让 agent 走过富化步骤,即:

- 对每篇新文章 view 一遍源文件
- 调 `record_pattern_evidence` 写回 topics + 已有 pattern_ids
- 发现新模式则调 `append_observation`(不直接进 style-patterns.md,先候选)

## 6. 写 SKILL_OVERLAY.md

如果该作者有特别需要 agent 知道的偏好,直接编辑 `$STYLEFORGE_HOME/authors/<slug>/SKILL_OVERLAY.md`,例如:

```markdown
## 该作者特有的偏好

- 这位作者经常在段尾用一个独立短句作"切角",不要并入上一段。
- 偶尔写英文,英文段落保持原貌不翻译。
- 避免讨论 X、Y 类话题(用户事后会反感)。
```

`get_writing_guide` 会自动把这部分一起返回给 agent。

## 7. 测试

```
/style-write lubin 写一段 200 字关于茶的小文。
```

不满意就反馈;反馈累积后跑 `/style-feedback lubin`。

## 8. 评审升格(语料到 15+ 篇之后)

到达 15 篇语料后,可以人工评审 observations.md,把反复出现的候选模式升格到 style-patterns.md 的 §1/§2/§3。这一步目前是手动的(将来可能加 `styleforge promote` 工具)。

升格的标准:

- **§1 核心规则**(>=70% 频次)— 几乎篇篇都有
- **§2 次级规则**(30%-70% 频次)— 相当一部分文章有
- **§3 低频规则**(<30%)— 部分文章有,但仍有特征性
- **observation**(单篇出现)— 暂不升格

升格不能在自动 ingest 流程里发生,必须人工读完观察日志后做决定。这是为了避免"小样本误导"——3 篇都有不等于"100% 频次"。
