# DSH 专用聊天会话桥接

当前主路径为 Chatagent → 本机桥接 → 已运行的 DSH 专用会话。Chatagent 保存消息、处理同步与附件交互；模型、记忆及工具在 DSH 中运行。0.4.6 修复 DSH 0.2.2-rc.1 的工具列表接口兼容问题，并保留 0.2.1-rc.3 路径。0.2.2-rc.1 验证使用官方 SDK 与本地合成适配器，不消耗真实模型额度；完整第三方插件组合仍需在实际机器验证。

## 安装与配置

在 DSH 的用户补丁中增加一个插件条目，`name` 指向本项目 `packages/dsh-bridge/index.mjs` 的绝对 file URL。配置示意：

```yaml
- insert:
    - id: chatagent-bridge
      name: file:///C:/Chatagent/packages/dsh-bridge/index.mjs
      config:
        root: C:/Chatagent/private/bridge
        cwd: C:/Chatagent/private/workspace
        tokenFile: C:/Chatagent/private/bridge-token.txt
        port: 37827
        agentPreset: standard
        timeZone: Asia/Shanghai
        llmModule: file:///C:/DSH/node_modules/@deepseek-ai/dsh-llm/lib/index.js
        compactionModule: file:///C:/DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js
```

路径按自己的安装位置调整。`root` 必须是新的专用目录；首次启动生成并保存专用 session ID。不要将已有 DSH 工作目录作为桥接资料目录。令牌文件至少 32 字符，使用随机生成的本地私有令牌；客户端与插件读取同一个文件。桥接只监听 127.0.0.1，手机通过 Chatagent 的已配对设备入口连接。

复制 `bridge.example.json` 为私有配置，填写绝对路径，运行 `node scripts/start-bridge.mjs <私有配置.json>`。这条命令不再创建独立 DSH SDK 实例。DSH 必须先运行并加载桥接。旧的独立 SDK 启动入口保留用于兼容和回退。

通过用户补丁中的绝对 `file:` 地址加载的桥接，并不是安装进 DSH profile 的独立 bundle；因此可能不在 DSH「插件」页显示独立卡片。检查是否加载应以桥接端口的认证 `/v1/status` 响应（`format: chatagent-dsh-bridge-v1`）、专用会话和实际新消息回执为准，不能只看插件列表。更换安装文件后须重新启动 DSH，才能让它重新加载桥接模块。出现 `reading 'filter'` 时先更新到 0.4.6；不要只把缺失工具列表补成空数组，那样会丢失或绕过原有工具权限过滤。

桥接会在 DSH 侧栏注册「Chatagent」工作区，并将专用会话关联其中。DSH 会隐藏尚未开始聊天的空会话；此时把鼠标移到「Chatagent」工作区，点击右侧「新会话」图标，DSH 会复用已关联的空会话。第一次真实聊天后，它会作为普通会话显示。历史资料保留在 Chatagent 时间线和桥接归档中，不会伪造新轮次来填充 DSH 对话列表。

每个聊天可设置近期窗口和摘要策略，完整历史保存在本地档案中。摘要维护安排在空闲时，不阻塞普通回复。上下文还可复用会话的 DSH compaction 服务；缺少时可通过 `compactionModule` 仅给专用会话挂接原生压缩插件。主动聊天由 Chatagent 的空闲时间、免打扰和次数限制触发，默认关闭；定时触发在 DSH 日志中标为 `chatagent-proactive`，不会伪装成用户新消息。主动聊天禁止工具执行。

## 资料与插件

首次迁移使用桥接 `/v1/import/preview` 和 `/v1/import/apply`，先预览再携带相同 digest 确认。资料以原文和来源保存，最近历史作为会话背景，完整原文通过 `chatagent_history_search` 查询。迁移不会重放旧任务。开始新对话后禁止再次执行首次迁移；后续 Chatagent 导入的历史通过 `/v1/archive` 去重同步，同一来源条目冲突会停止同步。

记忆引擎由 DSH 安装和配置。本次使用外置鱼 1.5.0；可选 `fish-v1.mjs` 迁移适配器只接受该版本的原生条目，保留删除状态，拒绝内容冲突，不修改记忆算法。普通聊天文本导入不会自动变成长期记忆。其他引擎需要自己的迁移适配器。

`local-media.mjs` 是可选的 DSH 媒体适配器，首次接入需指定 `mediaAdapter` 与应用的 `mediaOptions.attachmentsRoot`。Windows x64 可在「设置 → 语音」点「一键配置语音」，同时准备本地转文字和免费中文回复，并为当前聊天开启 `chatagent_send_voice`。首次下载约 300 MB，不用手动安装 Python、填写语音接口或选择显卡；已有可用 `asrRoot` 会复用。免费回复使用 Windows 已安装的中文声音，缺少时提示添加。图解教程入口为 `/speech-guide#walk/freevoice/0`；定制音色、唱歌、A 卡 / N 卡加速在进阶。

下载清单固定在 `packages/companion-capabilities/asr-downloads.json`，逐项核对长度与 SHA-256，安装清单校验和实际转写都通过才保存配置；失败不切换原有声音或开启工具，重试可复用已校验下载。便携环境默认在主桥接的 `voice-runtime`，子聊天共享，也可指定绝对路径 `mediaOptions.voiceRuntimeRoot`。不修改系统 Python 或 PATH；源码包不包含模型和运行库，安装保留其许可及 `SOURCES.json`。转写来源与声音选择按聊天保存在 `voice-replies/settings.json`，可恢复原有 `ttsRoot` 音色并保留转写。

管理接口为 `GET /v1/voice-replies`、`POST /v1/voice-replies/setup`、`POST /v1/voice-replies/preview`，只允许电脑端本地认证访问。配置需要当前会话与权限版本，等待上限 20 分钟；GET 返回阶段和下载进度。配置和试听期间阻止并发配置与备份。试听使用固定句子，不调用聊天模型、不写入聊天、不自动播放。基础转写与合成在电脑本地完成，聊天模型收到文字并按原有连接使用额度；免费系统声音不支持定制音色或唱歌。

想交给 Agent 配置时，打开 `/speech-guide#voice/agent` 选择功能并复制提示词，连同素材路径发给能操作本地文件、执行命令的 DSH / Codex。定制说话准备 WAV，原话可选；唱歌准备 RVC `.pth` 和配套 `.index`（如有），试唱音频可稍后选。复制不会自动执行配置。提示词会要求 Agent 检查实际引擎兼容性、独立准备环境、保留原配置并实际验证；尚未支持的环境、显卡或尚未试唱的部分须明确报告。

每个聊天的设置页读取 DSH 工具与插件清单，按用户插件来源分组展示说明和授权。列出工具表示 DSH 已公开该工具，不等于 Chatagent 已为新聊天全部授权。插件页管理用户自行添加的插件入口和子页面。原生工具通过 DSH 正常执行链运行。

已验证的旧版 dsh-gemini-pool 0.7.13 只识别嵌套工具结果。使用该版本时可显式设置 `legacyAntigravityTools: true`，仅在 Chatagent 会话的适配器调用边界转换格式并保留签名；其他会话不受影响。更新适配器后需重新验证，不应盲目开启兼容补丁。状态接口中的 `compatibility.legacyAntigravityTools` 可检查是否生效。

DSH 插件可依赖 `chatagentBridge` 服务，并调用 `publish({sessionId,deliveryId,text,attachments?})` 发送通知。session ID 必须与该桥接一致，delivery ID 必须稳定且唯一。模型可通过本会话工具 `chatagent_send_message` 投递通知。桥接保存待投递队列；客户端收到后幂等写入并确认。回执表示本机保存，不表示手机已读。

## 恢复边界

请求按 ID、输入和人格绑定。断线或重启仅核对 DSH 已完成的原生日志；结果不明不重新生成。专用会话身份变化会阻止客户端继续调用。

桥接模式中的 Chatagent 备份覆盖本地聊天、附件和客户端配置。DSH 原生会话、模型配置、插件及其记忆需要独立备份。恢复 Chatagent 备份不能回滚 DSH；请同时保留 DSH 资料、桥接根目录和令牌。旧独立 SDK 的完整备份仍可通过原恢复工具恢复。

项目处于早期开发阶段。发布包的许可状态见根目录 LICENSE 与 README；DSH 和外部插件保留各自许可证。
