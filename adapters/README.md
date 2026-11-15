# 聊天入口适配器

正式的聊天入口，替换临时脚本 `feishu/im.mjs`、`wechat/bridge.mjs`、`bridge/commands.mjs`。每个渠道一个独立进程，只持有**来源密钥**和**通道密钥**，不持有本人密钥。

```
adapters/
  chat/            共用：配置、状态文件、项目解析、消息解析、事件映射、卡片文本
  feishu-chat/     飞书聊天入口（lark-cli event consume + im +messages-send）
  wechat-clawbot/  个人微信 ClawBot 入口（ilink，@tencent-weixin/openclaw-weixin）
```

## 文件在哪

| 内容     | 位置                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 进程代码 | `~/.agent-autoloop/app/adapters/<名字>/main.ts`（随中枢部署检出）                       |
| 配置文件 | `~/mini-hub/ai-loop/secrets/<名字>.config.json`（600）                                  |
| 密钥文件 | `~/mini-hub/ai-loop/secrets/<名字>.json`（600，只有 `source`、`channel` 两个键）        |
| 状态文件 | `~/mini-hub/ai-loop/secrets/<名字>-state.json`（600：游标、凭据、待拍板卡片、当前项目） |
| 日志     | `~/Library/Logs/ai-loop-<名字>.log`                                                     |
| launchd  | `ai-loop-feishu-chat`、`ai-loop-wechat-clawbot`                                         |

配置字段：`hub`（中枢地址）、`me`（本人编号：飞书 open_id / 微信 userId）、`keysFile`、`rulesFile`（读已登记项目）、`stateFile`、`features`（`intake` 收指令、`notify` 发通知、`answers` 拍板，三个开关）、`policy`（消息政策，见下）、飞书另有 `lark`，微信另有 `accountFile`。

## 消息政策（《消息清单》落地）

发给本人的消息只留三类——**要拍板/动手的（decide）、本人提问的回复（reply）、本人说过要知道的结果（result）**，其它一律不推。政策在 `adapters/chat/notify.ts` 一处生效：

- **卡片**：`classify(card, policy)` 对照表先判，放行才发；压下的卡记进状态文件 `suppressed`（什么卡、为什么没发），中枢侧按 `delivered(version, ref=null)` 记账——不算投递失败、不重发、可在看板查。
- **回复文字**：本人发消息触发的回话（帮助、拍板回执、项目切换等）由 `act.ts` 产生，出门时统一过 `sanitize()`。
- **所有出站文字**（卡片渲染 `renderOwnerCard` + 直接回复）都过 `sanitize()`：凭据、内部代号、hub= 版本串、绝对路径、堆栈、JSON 报文、报错原文一律拦截，超长截断并注明「详情见看板」。
- **去重**：状态文件 `notified` 记 `卡片号→已发版本`，中枢把同一版本再 offer（投递回报丢失/重启重投）时不发第二遍文字，只把已存的送达 ref 补报回去；卡片新版本才再发。

### 加一类新消息

给配置文件加一条 `policy.rules`（排在内置表前面，先命中先赢）：

```json
"policy": {
  "rules": [
    { "text": "日报写完", "kind": "notice", "state": "closed", "to": "result", "note": "日报结果" }
  ]
}
```

字段：`title`/`text` 正则、`kind`（ask/notice/…）、`open`（true 只匹配 open）、`state`（精确状态）、`afterMinutes`（正文「N 分钟」达到才放行，设备离线阈值用）、`to`（`decide`/`result`/`suppress`）、`note`（审计理由）。表里没有的类型默认不推——**新卡片类型不写规则就是安全的**。

### 关某一类消息

```json
"policy": { "send": { "decide": true, "result": false } }
```

整类关掉不用动规则表；被整类关掉的卡记 `suppressed`，理由是「整类已关」。

### 微信凭据时效

`policy.tokenMaxAgeMs`：微信 `context_token` 只允许用「最新来信」带回来的；状态文件 `contextTokenAt` 记采集时刻，超过这个毫秒数的凭据不发——卡片按 `failed` 报回中枢（发送接口返回成功 ≠ 送达，实测见 `docs/系统架构.md`）。不写按内置 15 分钟算——2026-11-16 实测约 56 分钟凭据已被平台收而不投，真实失效点未测准，宁紧勿松。

## 首次安装

```sh
# 1. 微信传输包只装进它自己的目录（不进引擎 package.json）
cd ~/.agent-autoloop/app/adapters/wechat-clawbot && npm install

# 2. 规则：把 config-templates/chat-rules.json 的 agents/rules 并进 ~/.agent-autoloop/rules.json
#    （模板里有逐条说明；改完 agent-autoloop check ~/.agent-autoloop/rules.json）

# 3. 配置和密钥：secrets/ 下按 config.example.json 写好 config.json，密钥文件只放
#    {"source": "<来源密钥>", "channel": "<通道密钥>"}，全部 chmod 600。

# 4. 装服务（launchd 没有 node 的 PATH，plist 里已带 EnvironmentVariables）
cp adapters/feishu-chat/ai-loop-feishu-chat.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai-loop-feishu-chat.plist
cp adapters/wechat-clawbot/ai-loop-wechat-clawbot.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai-loop-wechat-clawbot.plist
```

## 切换（先飞书，后微信）

旧服务 `ai-loop-feishu-im`、`ai-loop-wechat-bridge` 本人每天在用，切之前确认新入口已经验过。

```sh
# 飞书：起新停旧
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai-loop-feishu-chat.plist
launchctl bootout gui/$(id -u)/ai-loop-feishu-im
tail -20 ~/Library/Logs/ai-loop-feishu-chat.log

# 微信：起新停旧（同一时刻只跑一个，两边都在长轮询会抢游标）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai-loop-wechat-clawbot.plist
launchctl bootout gui/$(id -u)/ai-loop-wechat-bridge
tail -20 ~/Library/Logs/ai-loop-wechat-clawbot.log
```

## 回退（一条命令切回旧脚本）

```sh
launchctl bootout gui/$(id -u)/ai-loop-feishu-chat   ; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai-loop-feishu-im.plist
launchctl bootout gui/$(id -u)/ai-loop-wechat-clawbot ; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai-loop-wechat-bridge.plist
```

旧 plist 一直留在 `~/Library/LaunchAgents/`，旧脚本和旧 secrets 文件不动。

## 已知边界

- **飞书文字拍板**：中枢按卡片号 + 送达 ref 两级校验，聊天入口不能领卡（会抢 feishu 通道的投递），也就拿不到 `卡片号→om_` 的映射。能用的拍板方式：卡片按钮、卡片文字框、或**引用回复那张卡片写「#卡片号 <序号或一句话>」**。帮助文案如实写了。
- **微信推送凭据**：`context_token` 来自最近一条来信；状态文件记 `contextTokenAt` 采集时刻，`policy.tokenMaxAgeMs` 超时不发。没凭据/凭据过期时卡片报 `failed` 不假装送达；来信一到凭据自动刷新。实测结论见 `docs/系统架构.md`（2026-11 探测：发送接口成功不代表送达）。
- **飞书只认本人 p2p 文本**：群聊、非文本、机器人消息一律不处理。
- 同一时刻微信入口只能跑一个进程（游标争抢）。`card.action.trigger` 归中枢 feishu 通道，本适配器不监听。
