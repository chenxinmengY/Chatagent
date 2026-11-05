# Chatagent

基于 DeepSeek Harness（DSH）的个人 AI 聊天客户端，提供电脑网页、Windows 桌面窗口与 Android 客户端。

Chatagent 负责聊天界面、消息保存与同步、角色管理和资料迁移；DSH 负责模型调用与插件执行。长期记忆可接入用户选择的 DSH 插件。

这是一个借助 AI 编程工具逐步实现的学习实践项目，目前处于早期开发阶段。项目重点是跨端交互、执行状态、插件接入和数据管理；语言模型、语音模型与记忆引擎来自第三方。可以通过源码、测试及[项目说明](docs/PROJECT_OVERVIEW.md)了解实现与边界。

## 功能

- 多角色聊天：各聊天独立配置人格、近期上下文窗口与工具权限。
- 消息与附件：SQLite 持久化、待发队列、分段气泡、语音录制和播放、断线恢复与幂等投递。
- 聊天行为：基础主动聊天、回复频率、近期窗口与话题摘要；历史原文保留并可检索。
- DSH 桥接：复用已有模型和工具；按来源展示用户插件、说明与权限，插件参数在对应宿主中配置。
- 可选插件入口：课表更新、提醒、音视频活动及记事本，需安装相应插件和运行环境。
- 资料迁移：Chatagent 便携包、WeChatAgent 档案、AstrBot 会话 JSONL，支持预检、去重、来源保留与缺失附件报告。
- 跨端体验：外观预览、Android 消息通知、最新消息预览、未读数与设备配对。

## 快速查看

需要 Node.js 24+。下面只启动本机界面和消息服务，不调用模型，也不读取已有 DSH 或微信资料：

```powershell
npm ci --ignore-scripts
npm start
```

打开终端输出的本机地址。AI 回复需要另行连接 DSH；入口保持在 `127.0.0.1`，手机访问需要显式配置设备网关和私人 HTTPS 连接。

## 接入 DSH

当前验证的 SDK 系列为 `@deepseek-ai/* 0.2.1-rc.3`；不同版本需重新验证。主路径是在已运行的 DSH 中加载本项目桥接插件，为 Chatagent 创建专用会话：

1. 按 [DSH 桥接说明](docs/DSH-BRIDGE.md)配置桥接插件、独立资料目录和随机令牌。
2. 复制 `bridge.example.json` 为 `bridge.private.json`，填写自己的绝对路径。
3. 运行 `node scripts/start-bridge.mjs bridge.private.json`。
4. 在 DSH 配置模型及所需插件，在每个 Chatagent 聊天中授权工具。

记忆可使用 [dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory)，原作者 **Yuuyuko-uu**，当前验证版本为 1.5.0，采用其独立插件许可。鱼插件代码不随本仓库分发；请自行安装并保留上游许可证。语音识别、合成、媒体和唱歌功能也需要另行准备运行环境及有权使用的模型或素材。

## 验证与构建

目前主要验证环境为 Windows、Node.js 24+、Java 17 与 OpenSSL。Android 行为测试使用实际 Java 源码和本地桩；不等同于所有手机系统上的实机验收。

```powershell
$env:CHATAGENT_JDK = 'C:\Java\jdk-17'
$env:CHATAGENT_OPENSSL = 'C:\Program Files\Git\usr\bin\openssl.exe'
npm test
```

测试使用临时目录与合成资料，无需真实聊天或模型密钥。DSH/Gemini 协议集成测试使用本地模拟响应；未安装可选 SDK 时会跳过该项。完整运行条件见 [安装与构建](docs/INSTALL.md)。

## 目录

| 目录 | 内容 |
| --- | --- |
| `apps/service` | 本机 HTTP 服务、同步接口与管理界面入口 |
| `apps/web` | 浏览器与桌面共用界面 |
| `apps/desktop` | Windows WebView2 窗口与托盘 |
| `apps/android` | Android 原生客户端 |
| `packages/dsh-bridge` | DSH 专用会话、工具和插件桥接 |
| `packages/conversation`、`packages/migration` | 消息存储、聊天策略与迁移 |
| `test` | 协议、存储、恢复、前端及 Android 回归 |

## 数据与来源

源码不附带真实聊天、记忆、人格、课表、账号、令牌、设备配对、模型权重、个人图片、开发签名或本机配置。运行中创建的私人目录也应保持在版本管理之外。发布前可使用 `scripts/prepare-source.mjs` 的白名单打包及隐私检查；不要直接上传整个运行目录。

- [数据、迁移与备份](docs/DATA.md)
- [插件边界](docs/PLUGINS.md)
- [第三方组件与许可证](THIRD_PARTY_NOTICES.md)
- [贡献说明](CONTRIBUTING.md)
- [隐私与问题报告](SECURITY.md)

自有代码采用 [MIT 许可证](LICENSE)。第三方组件保留各自许可证；外置插件与模型不因本仓库许可而改变其授权条件。
