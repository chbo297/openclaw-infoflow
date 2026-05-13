# Changelog

## 2026.5.8

### 优化

#### 群聊默认输出卫生（GroupSystemPrompt）

- 所有实际下发到 LLM 的群聊消息，在 `GroupSystemPrompt` **末尾**统一追加一段固定规则：对群只发最终用户可见结论；不贴工具调用轨迹、原始检索中间结果；多步探索用 subagent（或等价隔离）完成后只返回合并结论。用户若明确要求「过程」，以同条回复内的简短步骤摘要满足，仍不贴原始工具日志。
- 该段落在各群 `systemPrompt` 配置合并**之后**追加，避免配置侧无意弱化上述约束。

#### 发版维护

- 新增 `scripts/sync-readme-install-version.mjs` 与 `npm run sync-readme-install-version`，按 `package.json` 的 `version` 重写 README 中带标记的安装示例与发版命令块，减少文档与 npm 版本不一致。

---

## 2026.5.7

### 优化

#### watchMentions / watchRegex 群系统提示（GroupSystemPrompt）

- **开场文案**：在有人 @ 了 `watchMentions` 中的用户时，明确先结合线程与引用上下文、知识与工具判断能否提供直接答案、可执行下一步或有用线索；强调单次最终回复，避免在群内试探性多轮刷屏。
- **共享拒答规则变体**：为 `watchMentions` 与 `watchRegex` 路径使用 `watchAssistant` 变体，从「何时不回复」中移除「消息是发给另一个人的，而不是发给你」一条，避免与「作为被 @ 用户的助手代为判断是否帮助」语义冲突；`followUp` 与 `proactive` 仍保留原完整规则。

---

## 2026.3.17

### 修复与优化

#### follow-up（跟进回复）策略

- **他人被 @ 时仅记录不派发**：在 follow-up 时间窗口内，若新消息 @ 了其他人或机器人（而非本 bot），则仅写入会话历史、不派发 LLM，避免误判为对机器人的追问。
- **LLM 可见 body 含 robotid**：群消息中 @ 提及会以「@名称 (robotid:N)」形式呈现给模型，便于区分不同机器人并做出更准确的回复判断。

---

## 2026.3.15

### 新功能

#### watchRegex 支持数组

- `watchRegex` 可配置为字符串或字符串数组，支持多条正则；命中任一条即触发回复判断。

#### Markdown 本地图片

- 回复内容中的本地图片 URL（`/`、`./`、`file://` 等）会解析并转为 base64，以如流图片消息形式发送，避免链接不可访问。

### 优化

#### follow-up（跟进回复）判定逻辑

- 机器人更智能地判断是否在跟进窗口内回复——
  - **提高回复倾向**：当发言者表现出期望得到回应的意愿（例如追问、延续同一话题）时，增加机器人回复的可能性；
  - **降低回复倾向**：当发言者明确禁止机器人回复（例如「不用回了」「别回复」等）时，降低机器人回复的可能性。

### Bug 修复

- 修复消息分片发送时顺序错乱的问题。

---

## 2026.3.10

### Bug 修复

- 修复来自 bot 的消息处理逻辑（避免对机器人自身消息错误响应）。

---

## 2026.3.8

### 新功能

#### watchRegex（正则匹配群消息）

- 支持 `watchRegex` 配置：按正则表达式匹配群内聊天内容，命中时触发机器人参与并回复
- 可在顶层、账号级别或按群（`groups.<groupId>.watchRegex`）单独配置
- 需配合 `replyMode` 为 `mention-and-watch` 或 `proactive` 使用

#### 撤回消息

- 支持私聊消息撤回能力，需在配置中填写如流企业后台的 `appAgentId`（应用 ID）

### Bug 修复

- 修复了一些消息回复失败的问题

---

## 2026.2.28

### 新功能

#### 助手模式与 @mention 能力

- 支持 `watchMentions` 配置：当群内有人 @了 watchMentions 列表中的用户时，机器人作为该用户的助手自动判断是否代为回复
- 支持识别群消息中的 @mention（人类用户和机器人），并在回复中正确生成 @mention 内容
- 新增 `at-agent` 消息类型，支持在回复中 @其他机器人

#### Follow-Up 跟进回复

- 支持 `followUp` 配置（默认开启）：机器人回复后，在 `followUpWindow`（默认 300 秒）时间窗口内，即使未被 @，也会判断后续消息是否是对之前话题的延续并决定是否回复
- 通过内存 Map 跟踪每个群的最后回复时间

#### 回复模式系统（replyMode）

新增 5 种群聊回复模式，支持按群独立配置：

| 模式 | 行为 |
| --- | --- |
| `ignore` | 直接丢弃，不记录、不思考、不回复 |
| `record` | 仅记录到会话，不思考、不回复 |
| `mention-only` | 仅在机器人被直接 @ 时回复 |
| `mention-and-watch`（默认） | 机器人被 @、或 watchMentions 中的用户被 @、或处于 follow-up 窗口内时回复 |
| `proactive` | 始终思考并判断是否回复 |

#### 消息动作（Actions）

- 新增 `ChannelMessageActionAdapter` 实现，支持 LLM Agent 通过 `send` action 主动发送消息
- 支持 `atAll`、`mentionUserIds`、`media` 等参数

---

### 重构

#### 日志系统统一

- 移除 `logInfoflowApiError`，新增统一的 `logVerbose()` 函数
- 全项目统一使用 `logVerbose()` 替代分散的 verbose 日志判断逻辑
- 统一使用 `formatInfoflowError()` 格式化错误信息
- 改进多处错误日志的上下文信息

---

### ⚠️ 不兼容变更

#### openclaw.plugin.json 配置格式变更

群聊配置部分有较大变更，**不兼容以前的格式**。主要变更：

- 新增顶层 `replyMode`、`followUp`、`followUpWindow`、`watchMentions` 字段
- 新增 `groups` 对象，支持按群 ID 独立配置（`replyMode`、`watchMentions`、`followUp`、`followUpWindow`、`systemPrompt`）
- 新增 `defaultAccount` 字段
- `accounts` 下每个账号也可嵌套独自的 `groups` 配置
- 配置解析优先级：群级别 → 账号级别 → 顶层默认值

旧的 `requireMention` 字段仍可用（内部自动映射到新的 replyMode），但建议迁移到新的 `replyMode` 配置。

新配置示例：

```json5
{
  channels: {
    infoflow: {
      replyMode: "mention-and-watch",
      followUp: true,
      followUpWindow: 300,
      watchMentions: ["alice01", "bob02"],
      groups: {
        "12345": {
          replyMode: "proactive",
          systemPrompt: "你是项目 X 的专家...",
          watchMentions: ["alice01"],
        },
      },
    },
  },
}
```
