[中文](#中文) | [English](#english)

---

<a id="中文"></a>

# @chbo297/infoflow

百度如流 (Infoflow) 企业消息平台 — OpenClaw 频道插件。

## 特性

- **私聊 & 群聊**消息接收与回复
- 群内 **@机器人** 检测，被 @提及 时自动回复
- **watchMentions（关注提及）**：监控指定人员被 @ 时，机器人作为其助手判断是否代为回复
- **watchRegex（正则匹配）**：按正则匹配群内聊天内容，命中时触发机器人回复
- **followUp（跟进回复）**：机器人回复后，在时间窗口内智能判断后续消息是否为追问，无需再次 @
- 五种 **replyMode（回复模式）**：从完全忽略到主动参与，灵活控制群内行为
- **按群独立配置**：每个群可设置不同的回复策略和系统提示词
- **多账号支持**：一个实例管理多个如流机器人
- **Agent 主动/定时发送**：LLM Agent 可主动或定时发送私聊消息、往群里发消息，支持 @指定用户或 @全员
- **Markdown 本地图片**：回复内容中的本地图片路径会自动转为图片消息发送

## 安装

### 通过 npm

```bash
openclaw plugins install @chbo297/infoflow
```

### 本地安装

```bash
openclaw plugins install ./path/to/openclaw-infoflow
```

## 环境要求

- OpenClaw **>= 2026.3.2**

## 快速开始

```json5
{
  channels: {
    infoflow: {
      enabled: true,
      apiHost: "https://apiin.im.baidu.com",
      checkToken: "your-check-token",
      encodingAESKey: "your-encoding-aes-key",
      appKey: "your-app-key",
      appSecret: "your-app-secret",
      robotName: "MyBot", // 用于群内 @提及 检测
    },
  },
}
```

### Webhook 地址

将如流机器人的 webhook URL 配置为：

```
https://your-domain/webhook/infoflow
```

修改配置后需重启网关。

## 回复模式 (replyMode)

通过 `replyMode` 控制机器人在群聊中的参与程度，默认值为 `mention-and-watch`。

| 模式 | 行为 |
|------|------|
| `ignore` | 丢弃消息，不保存、不思考、不回复 |
| `record` | 仅保存到会话历史，不思考、不回复 |
| `mention-only` | 仅在机器人被 @提及 时回复 |
| `mention-and-watch` | 机器人被 @、或被关注的人被 @、或在跟进窗口内时回复 **（默认）** |
| `proactive` | 始终参与思考，可能主动回复所有消息 |

## 关注提及 (watchMentions)

配置需要关注的人员列表。当群内有人 @提及 列表中的人时，机器人作为其助手判断是否能代为回答。

```json5
{
  channels: {
    infoflow: {
      watchMentions: ["alice01", "bob02"],
      // 需配合 replyMode 为 "mention-and-watch" 或 "proactive"
    },
  },
}
```

**匹配优先级**：`userid` > `robotid`（数字）> 显示名称

**行为**：
- 机器人通过 LLM 判断是否有能力代为回答
- 如果有把握 → 直接回复
- 如果无法帮助 → 静默不回复

## 正则匹配 (watchRegex)

通过正则表达式匹配群内聊天内容，当消息文本命中任一正则时，会触发机器人参与并回复（需配合 `replyMode` 为 `mention-and-watch` 或 `proactive`）。`watchRegex` 可配置为**字符串**或**字符串数组**（多条正则，命中其一即触发）。可在顶层、账号或按群单独配置。

```json5
{
  channels: {
    infoflow: {
      watchRegex: ["^(帮忙|请帮我)", "\\?$"],  // 顶层：数组形式，多条正则
      groups: {
        "123456": {
          watchRegex: "\\?$|怎么|如何",   // 该群：单条正则，匹配以问号结尾或含「怎么」「如何」的消息
        },
      },
    },
  },
}
```

**说明**：正则采用 JavaScript 标准语法；与 watchMentions、@提及 等条件并列，任一满足即可触发回复判断。

## 跟进回复 (followUp)

机器人回复后，在 `followUpWindow` 时间窗口内（默认 300 秒），后续消息即使没有 @机器人 也会触发智能判断：

- 如果是同一话题的追问 → 继续回复
- 如果是无关的新话题 → 静默不回复

```json5
{
  channels: {
    infoflow: {
      followUp: true,       // 默认 true
      followUpWindow: 300,  // 秒，默认 300
    },
  },
}
```

## 按群配置 (groups)

可以为每个群设置独立的回复策略，覆盖全局默认值。

```json5
{
  channels: {
    infoflow: {
      replyMode: "mention-and-watch", // 全局默认
      groups: {
        "123456": {
          replyMode: "mention-and-watch",
          watchMentions: ["team-lead01"],
          watchRegex: "^(帮忙|求助)",
          followUp: true,
          followUpWindow: 600,
          systemPrompt: "你是这个项目组的技术助手。",
        },
        "789012": {
          replyMode: "record", // 此群仅记录不回复
        },
      },
    },
  },
}
```

**配置优先级**：群级别 > 账号级别 > 顶层默认值

## 访问控制

### 私聊策略 (dmPolicy)

| 值 | 说明 |
|---|------|
| `open` | 允许所有用户私聊（默认） |
| `pairing` | 需配对确认 |
| `allowlist` | 仅允许 `allowFrom` 列表中的用户 |

### 群聊策略 (groupPolicy)

| 值 | 说明 |
|---|------|
| `open` | 允许所有群触发（默认） |
| `allowlist` | 仅允许 `groupAllowFrom` 列表中的群 |
| `disabled` | 禁用群聊 |

## 多账号支持

```json5
{
  channels: {
    infoflow: {
      enabled: true,
      replyMode: "mention-and-watch", // 所有账号的默认值
      accounts: {
        work: {
          checkToken: "token-1",
          encodingAESKey: "key-1",
          appKey: "app-key-1",
          appSecret: "secret-1",
          robotName: "WorkBot",
          replyMode: "mention-and-watch",
          watchMentions: ["manager01"],
        },
        personal: {
          checkToken: "token-2",
          encodingAESKey: "key-2",
          appKey: "app-key-2",
          appSecret: "secret-2",
          robotName: "PersonalBot",
        },
      },
      defaultAccount: "work",
    },
  },
}
```

## 完整配置参考

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 是否启用 |
| `apiHost` | `string` | — | 如流 API 地址 |
| `checkToken` | `string` | — | 验证 token **（必填）** |
| `encodingAESKey` | `string` | — | 消息加密密钥 **（必填）** |
| `appKey` | `string` | — | 应用 Key **（必填）** |
| `appSecret` | `string` | — | 应用 Secret **（必填）** |
| `robotName` | `string` | — | 机器人名称，用于 @提及 检测 |
| `appAgentId` | `number` | — | 如流企业后台的应用 ID，私聊消息撤回依赖此字段 |
| `replyMode` | `string` | `"mention-and-watch"` | 回复模式 |
| `followUp` | `boolean` | `true` | 是否启用跟进回复 |
| `followUpWindow` | `number` | `300` | 跟进窗口（秒） |
| `watchMentions` | `string[]` | `[]` | 关注提及的人员列表 |
| `watchRegex` | `string` \| `string[]` | — | 正则或正则数组，匹配群消息内容时触发回复 |
| `dmPolicy` | `string` | `"open"` | 私聊策略 |
| `allowFrom` | `string[]` | `[]` | 私聊白名单 |
| `groupPolicy` | `string` | `"open"` | 群聊策略 |
| `groupAllowFrom` | `string[]` | `[]` | 群聊白名单 |
| `groups` | `object` | — | 按群配置，key 为群 ID |
| `accounts` | `object` | — | 多账号配置 |
| `defaultAccount` | `string` | — | 默认账号 ID |

### groups.\<groupId\> 子字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `replyMode` | `string` | 覆盖该群的回复模式 |
| `watchMentions` | `string[]` | 覆盖该群的关注列表 |
| `watchRegex` | `string` \| `string[]` | 覆盖该群的正则匹配规则（可为单条或数组），匹配群消息内容时触发回复 |
| `followUp` | `boolean` | 覆盖该群的跟进开关 |
| `followUpWindow` | `number` | 覆盖该群的跟进窗口 |
| `systemPrompt` | `string` | 该群专属系统提示词 |

## Agent 主动发送 (Actions)

LLM Agent 可通过 `send` action 主动发送消息：

| 参数 | 类型 | 说明 |
|------|------|------|
| `to` | `string` | **必填**。目标：用户名（私聊）或 `group:<groupId>`（群聊） |
| `message` | `string` | 消息文本内容 |
| `atAll` | `boolean` | 群消息中 @所有人 |
| `mentionUserIds` | `string` | 群消息中 @指定用户，逗号分隔 |
| `media` | `string` | 附带链接 URL |

## 许可证

MIT

---

<a id="english"></a>

# @chbo297/infoflow

Baidu Infoflow (如流) enterprise messaging platform — OpenClaw channel plugin.

## Features

- **Direct & group** message receiving and replying
- **@mention detection** in groups — auto-reply when the bot is @mentioned
- **watchMentions**: monitor specified people; when they are @mentioned, the bot acts as their assistant and decides whether to reply on their behalf
- **watchRegex**: match group chat content by regex; when a message matches, trigger the bot to reply
- **followUp**: after the bot replies, intelligently judge whether subsequent messages are follow-up questions within a time window — no need to @mention again
- Five **replyMode** levels: from fully ignoring to proactively engaging, flexibly control group behavior
- **Per-group config**: each group can have its own reply strategy and system prompt
- **Multi-account support**: manage multiple Infoflow bots from a single instance
- **Agent-initiated / scheduled sending**: LLM Agent can proactively or on a schedule send DMs, post messages to groups, @specific users, or @all members
- **Markdown local images**: local image paths in reply content are converted and sent as image messages

## Install

### Via npm

```bash
openclaw plugins install @chbo297/infoflow
```

### Local checkout

```bash
openclaw plugins install ./path/to/openclaw-infoflow
```

## Requirements

- OpenClaw **>= 2026.3.2**

## Quick Start

```json5
{
  channels: {
    infoflow: {
      enabled: true,
      apiHost: "https://apiin.im.baidu.com",
      checkToken: "your-check-token",
      encodingAESKey: "your-encoding-aes-key",
      appKey: "your-app-key",
      appSecret: "your-app-secret",
      robotName: "MyBot", // used for @mention detection in groups
    },
  },
}
```

### Webhook URL

Configure your Infoflow bot webhook URL to:

```
https://your-domain/webhook/infoflow
```

Restart the gateway after config changes.

## Reply Modes (replyMode)

Control how the bot participates in group chats via `replyMode`. Default: `mention-and-watch`.

| Mode | Behavior |
|------|----------|
| `ignore` | Discard messages — no saving, no thinking, no reply |
| `record` | Save to session history only — no thinking, no reply |
| `mention-only` | Reply only when the bot is directly @mentioned |
| `mention-and-watch` | Reply when bot is @mentioned, a watched person is @mentioned, or within follow-up window **(default)** |
| `proactive` | Always think and potentially reply to all messages |

## Watch Mentions (watchMentions)

Configure a list of people to watch. When someone in the group @mentions a person on this list, the bot acts as their assistant and decides whether to answer on their behalf.

```json5
{
  channels: {
    infoflow: {
      watchMentions: ["alice01", "bob02"],
      // Requires replyMode "mention-and-watch" or "proactive"
    },
  },
}
```

**Matching priority**: `userid` > `robotid` (numeric) > display name

**Behavior**:
- The bot uses LLM to judge whether it can answer on behalf
- Confident it can help → replies directly
- Cannot help → stays silent (NO_REPLY)

## Regex Match (watchRegex)

Match group chat content with a regular expression; when a message matches any pattern, the bot is triggered to participate and reply (requires `replyMode` `mention-and-watch` or `proactive`). `watchRegex` can be a **string** or **string array** (multiple patterns; any match triggers). Can be set at top level, per account, or per group.

```json5
{
  channels: {
    infoflow: {
      watchRegex: ["^(help|please)", "\\?$"],  // Top-level: array of patterns
      groups: {
        "123456": {
          watchRegex: "\\?$|how to|what is",  // This group: single pattern
        },
      },
    },
  },
}
```

**Note**: Regex uses standard JavaScript syntax. It works alongside watchMentions and @mention; any condition can trigger reply evaluation.

## Follow-Up (followUp)

After the bot replies, any subsequent message within the `followUpWindow` (default 300 seconds) triggers intelligent judgment — even without @mentioning the bot:

- Same topic / follow-up question → continue replying
- Unrelated new topic → stay silent

```json5
{
  channels: {
    infoflow: {
      followUp: true,       // Default: true
      followUpWindow: 300,  // Seconds, default: 300
    },
  },
}
```

## Per-Group Config (groups)

Set independent reply strategies for each group, overriding the global defaults.

```json5
{
  channels: {
    infoflow: {
      replyMode: "mention-only", // Global default
      groups: {
        "123456": {
          replyMode: "mention-and-watch",
          watchMentions: ["team-lead01"],
          watchRegex: "^(help|urgent)",
          followUp: true,
          followUpWindow: 600,
          systemPrompt: "You are the tech assistant for this project team.",
        },
        "789012": {
          replyMode: "record", // This group records only, no replies
        },
      },
    },
  },
}
```

**Config priority**: group-level > account-level > top-level defaults

## Access Control

### DM Policy (dmPolicy)

| Value | Description |
|-------|-------------|
| `open` | Allow all users to DM (default) |
| `pairing` | Require pairing confirmation |
| `allowlist` | Only allow users in `allowFrom` list |

### Group Policy (groupPolicy)

| Value | Description |
|-------|-------------|
| `open` | Allow all groups to trigger the bot (default) |
| `allowlist` | Only allow groups in `groupAllowFrom` list |
| `disabled` | Disable group messaging |

## Multi-Account

```json5
{
  channels: {
    infoflow: {
      enabled: true,
      replyMode: "mention-only", // Default for all accounts
      accounts: {
        work: {
          checkToken: "token-1",
          encodingAESKey: "key-1",
          appKey: "app-key-1",
          appSecret: "secret-1",
          robotName: "WorkBot",
          replyMode: "mention-and-watch",
          watchMentions: ["manager01"],
        },
        personal: {
          checkToken: "token-2",
          encodingAESKey: "key-2",
          appKey: "app-key-2",
          appSecret: "secret-2",
          robotName: "PersonalBot",
        },
      },
      defaultAccount: "work",
    },
  },
}
```

## Full Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the channel |
| `apiHost` | `string` | — | Infoflow API base URL |
| `checkToken` | `string` | — | Verification token **(required)** |
| `encodingAESKey` | `string` | — | AES encryption key **(required)** |
| `appKey` | `string` | — | Application key **(required)** |
| `appSecret` | `string` | — | Application secret **(required)** |
| `robotName` | `string` | — | Bot name for @mention detection |
| `appAgentId` | `number` | — | Infoflow app ID (enterprise console); required for DM message recall |
| `replyMode` | `string` | `"mention-and-watch"` | Reply mode |
| `followUp` | `boolean` | `true` | Enable follow-up replies |
| `followUpWindow` | `number` | `300` | Follow-up window (seconds) |
| `watchMentions` | `string[]` | `[]` | List of people to watch for @mentions |
| `watchRegex` | `string` \| `string[]` | — | Regex or array of regexes; when matched, trigger reply |
| `dmPolicy` | `string` | `"open"` | DM access policy |
| `allowFrom` | `string[]` | `[]` | DM allowlist |
| `groupPolicy` | `string` | `"open"` | Group access policy |
| `groupAllowFrom` | `string[]` | `[]` | Group allowlist |
| `groups` | `object` | — | Per-group config, keyed by group ID |
| `accounts` | `object` | — | Multi-account config |
| `defaultAccount` | `string` | — | Default account ID |

### groups.\<groupId\> fields

| Field | Type | Description |
|-------|------|-------------|
| `replyMode` | `string` | Override reply mode for this group |
| `watchMentions` | `string[]` | Override watch list for this group |
| `watchRegex` | `string` \| `string[]` | Override regex for this group (single or array); match group content to trigger reply |
| `followUp` | `boolean` | Override follow-up toggle for this group |
| `followUpWindow` | `number` | Override follow-up window for this group |
| `systemPrompt` | `string` | Custom system prompt for this group |

## Actions (Agent-Initiated Sending)

LLM Agent can proactively send messages via the `send` action:

| Parameter | Type | Description |
|-----------|------|-------------|
| `to` | `string` | **Required**. Target: username (DM) or `group:<groupId>` (group) |
| `message` | `string` | Message text content |
| `atAll` | `boolean` | @all members in group messages |
| `mentionUserIds` | `string` | @specific users in group, comma-separated |
| `media` | `string` | Attached link URL |

## License

MIT
