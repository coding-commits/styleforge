# 故障排查

## 误喂了不该喂的语料

```
"列出 hbdxsl 的快照"
"回退到 2026-04-26T14-29-58"
```

或在 GUI 里手动:`$STYLEFORGE_HOME/authors/<slug>/snapshots/`。

回退本身也会先快照当前状态(label `pre-rollback-...`),所以"回滚的回滚"也支持。

**注意**:rollback 只恢复 `corpus-index.json` 等小文件,**不会自动删除 `corpus/` 下的原文件**。这是有意为之的——原文是"原材料",对删除保持保守。如果你的 corpus/ 积累了被 rollback 抛弃的孤儿文件,它们对系统无害(索引里没有引用),但占磁盘。手动清理:

```bash
ls $STYLEFORGE_HOME/authors/<slug>/corpus/    # 看实际文件
cat $STYLEFORGE_HOME/authors/<slug>/corpus-index.json | jq '.entries[].source_path'
# 比对,删除孤儿
```

未来版本可能加 corpus 垃圾回收工具。

## 文章吸收时被当成"近似重复"

可能原因:
- 同一作者把旧文修订后再发,正文 80%+ 相同
- 不同作者抄袭/引用同一段长文
- SimHash 误报(碰撞概率虽低但非零)

处理(在对话中告诉 Claude):
- "把这个当作新文章吸收" → agent 会带 `allow_near=true` 重新调用
- "跳过这些近似重复" → agent 会带 `skip_near=true`
- "调高近似阈值到 10" → agent 会带 `threshold=10`(默认 6)

## 风格采样总是返回同一类文章

可能 corpus 里某主题占比过高。处理:

```
"显示 hbdxsl 的统计"                    → get_stats(看 topics 分布)
"采样 hbdxsl 的 history 主题文章"       → sample_corpus topic="history"
```

或主动补充少数主题的语料。

## 规则文件被改坏了

```
"列出快照"
"回退,只恢复 style-patterns.md"  → rollback 加 only:["style-patterns.md"]
```

## ingest 后 stats 显示 100% 频次,但语料只有几篇

这是预期现象,不是 bug。3 篇语料里"100% 都有"只能算"出现于种子语料",不是统计意义上的"作者通篇风格"。`get_stats` 在 entries < 15 时会附带 `sample_warning` 字段。等语料到 15+ 篇,频次才有意义。

## 删错了作者

`delete_author` 后,作者目录会被 rm。**没有撤销机制**(快照在被删的目录里,一起没了)。

预防方案:
- 平时定期把 `$STYLEFORGE_HOME` 整体备份(rsync 或 git)
- 删除前先 `cp -r ...`

我们故意不在工具里加"软删除"——容易被误以为安全,反而疏于备份。

## 数据目录搬到别的机器

```bash
# 源机器
tar czf styleforge-data.tar.gz -C $(dirname $STYLEFORGE_HOME) $(basename $STYLEFORGE_HOME)

# 目标机器
tar xzf styleforge-data.tar.gz -C ~  # 假设默认位置
```

或者:安装 styleforge 时,直接把 data_dir 设为云盘里的路径(iCloud/Dropbox/OneDrive),自动同步。注意快照目录会膨胀,留意磁盘配额。

## 重装 / 升级 styleforge

`.mcpb` 升级不影响 `$STYLEFORGE_HOME` 数据。直接安装新版本即可。

如果你想换数据目录:在 MCP 客户端的扩展设置里改 styleforge 的 data_dir,然后手动把旧路径里的 `authors/` 移过去。

## 排查 server 日志

以 Claude Desktop 为例,扩展日志在:
- macOS: `~/Library/Logs/Claude/mcp*.log`
- Windows: `%APPDATA%\Claude\logs\mcp*.log`

styleforge 把致命错误写到 stderr,会出现在这些日志里。
