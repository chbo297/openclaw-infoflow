# Changelog

## 2026.5.9-beta.1

### 修复

#### 撤回消息时大模型误把入站 messageId 当作撤回目标

- **现象**：用户引用回复 bot 的某条消息并要求"撤回"，LLM 把当前入站消息（用户那条）的 `messageId` 传给 `action=delete`，store 查不到 → 报"需要 msgseqid"失败。
- **根因**：被引用消息的 `messageid` 只用于 `checkReplyToBot` 的 boolean 判断，从未透传给 LLM；LLM 只能看到 `ReplyToBody`（被引用消息的正文）和自己当前入站消息 ID，无法区分二者。

#### 跨上下文发送的 bot 消息在目标群里"失忆"

- **现象**：私聊里让 bot 跨发到群 X 的消息，会写入 `sent-messages.db`，但群 X 的 LLM session 历史里完全没有，导致后续在群里继续聊天时 LLM 表现得像"没发过那条消息"。
- **根因**：openclaw 的 session 历史是 per-session 的，跨 session 触发的出站消息天然在目标会话历史之外；本插件未在群消息进入 LLM 之前把这部分上下文补上。

### 改动

#### bot.ts：上下文注入

- `checkReplyToBot` 改造为 `resolveReplyTargets`，返回结构化数组 `{ messageid, preview, isBotMessage }`，保留旧 boolean API 作为派生 shim 不破坏旧测试。
- 在 `handleInfoflowMessage` 构造 ctxPayload 之后注入两段 system 上下文：
  - **Quoted reply target**：当入站是引用回复时，列出每个被引用消息的 `messageId + sentByBot + preview`，附明确指令"sentByBot=true 时该 id 是 action target"。
  - **Recent bot messages**：按 target 倒序查 `sent-messages.db` 最近 24h 内的 bot 消息，ambient 模式 5 条（普通群聊 ≈150 token）/ detail 模式 10 条（识别到撤回关键词或 reply-to-bot 时 ≈400 token），后者还会附"NEVER 用当前入站 message_id 作为 delete 目标"硬约束。
- 同步登记 inbound-context（accountId/target/inboundMessageId/replyToMessageId），供 delete handler 兜底使用。

#### actions.ts：delete handler 增加 replyToMessageId 兜底

- 群单消息分支：LLM 传的 `messageId` 在 store 查不到 + 入站存在 reply-to-bot 时，自动替换为 `replyToMessageId` 并使用 store 中对应的 `msgseqid` 继续撤回；记审计日志。若依然没有候选，抛错时携带最近 5 条 bot 消息的 `messageId + digest` 列表，让 LLM 二轮自纠（不自动 count=1，避免误撤）。
- 私聊单消息分支：同样的 fallback 路径；若 fallback 不可用，**保持原有 permissive 行为**（透传 LLM 的 id 给 Infoflow API，由后端判定），不引入硬门禁，避免对原本能成的边界场景产生 regression。

#### channel.ts：messageToolHints 强化 + 注册 agentTools

- `messageToolHints` 改为多行明确版，包含"绝不要把当前入站 message_id 当成 delete 目标"以及如何使用 ambient/detail 注入段、引用目标段、`infoflow_list_sent_messages` 工具的指引。
- 新增 `agentTools` 工厂，挂载 `infoflow_list_sent_messages` LLM 工具。

#### 新增 agent tool：`infoflow_list_sent_messages`

- 通过 `ChannelPlugin.agentTools` 注册的 typebox-schema LLM 工具。参数：
  - `target`（必填，强制当前会话）
  - `count`（可选，1-50，默认 20）
  - `withinHours`（可选，1-168，对齐 db 7 天保留窗口）
  - `containsText`（可选，digest 子串大小写不敏感匹配）
  - `accountId`（可选，多账号场景下指定）
- 返回 `{ messageId, sentAt, ageMinutes, preview }` 列表，用于查询超出 push 注入窗口或按内容定位的 bot 消息，供 LLM 喂回 `action="delete"`。

#### 内部模块

- 新增 `src/inbound-context.ts`：进程内 Map，登记 inbound 触发的 replyTo 上下文，TTL 10 分钟、上限 500 条，自动按时间淘汰。
- 新增 `src/agent-tools.ts`：`createListSentMessagesTool` 工厂。
- `package.json`：`typebox` 加入 `dependencies` 以保证生产部署 `npm install` 能装上（避免依赖 npm 7+ 默认装 peerDeps）。

### 测试

- 新增 45 个测试用例覆盖 `resolveReplyTargets`、`looksLikeRecallIntent`、`buildBotRecentMessagesSection`（ambient/detail/24h 截断/查询异常吞抛）、`formatQuotedReplyTargetsSection`、`inbound-context` TTL/evict/跨上下文拒绝、`actions` 中群+私聊 `replyToMessageId` 兜底与候选错误信息、私聊"未知 id 透传 API"回归保护、以及 `infoflow_list_sent_messages` 工具的 schema/count cap/withinHours/containsText/accountId 等。共 255 用例全部通过。

---

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
