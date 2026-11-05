# 安装、构建与升级

基础服务需要 Node.js 24+。`npm ci --ignore-scripts` 后执行 `npm start` 可在本机查看界面；未连接 DSH 时不提供 AI 回复。主部署方式为先在 DSH 加载桥接，再运行 `node scripts/start-bridge.mjs bridge.private.json`，详见 [DSH-BRIDGE.md](DSH-BRIDGE.md)。长期记忆与语音均为可选依赖。任意 DSH 版本或插件并不自动兼容。

旧独立 SDK 路径使用 `workspace.example.json`。其中 SDK 根指向包含 `dsh-agent`、`dsh-session` 等包的 `@deepseek-ai` 目录，`fishRoot` 由使用者提供；所有路径均为占位示例。`dataRoot` 必须是新的绝对路径，不应指向已有生产资料根。

Windows 桌面构建需要 .NET Framework 编译器、PowerShell 和 WebView2 Runtime：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1 -Configuration C:\Chatagent\bridge.private.json
```

脚本会下载固定版本的 WebView2 SDK 并核对 SHA-256，也可使用 `-WebViewSdk` 提供已解压 SDK。生成的 desktop.private.json 包含个人路径，不能作为通用配置发布。桌面与浏览器连接同一个服务。

Android 使用 Java 17、Android build-tools 37.0.0 与 android-37.0 平台包；构建工具不在仓库中：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android.ps1 -SdkRoot C:\Android\Sdk -JdkRoot C:\Java\jdk-17 -BuildRoot C:\ChatagentBuild
```

构建目录使用无中文绝对路径。开发签名保存在 .local-signing，不能提交。开发 APK 只能覆盖安装具有相同包名和签名的版本；不要通过卸载旧应用来绕过签名错误，否则会失去本地草稿和待发资料。正式发布应独立管理发行签名，目前脚本生成的是开发包。

升级前从聊天页生成联合备份，保存旧源码和签名；停下当前 Chatagent 服务后更新代码，继续使用原 dataRoot。恢复时始终选新目录，核对恢复报告和待核对消息后再连接。未知结果不会自动重放。不要直接拿旧源码写回已升级过的数据库，回退应使用升级前备份恢复到新目录。

测试保证源文件行为和协议回归，不代表每台 Android 手机的手势、通知和系统存储权限已经真机验收。

完整测试目前在 Windows 验证，需要 Java 17 与 OpenSSL。设置 `CHATAGENT_JDK` 和 `CHATAGENT_OPENSSL` 到自己的安装位置。可选协议集成测试可通过 `CHATAGENT_DSH_SDK` 与 `CHATAGENT_GEMINI_POOL` 指定已安装代码；测试响应由本地注入，不读取真实账号，也不调用模型。缺少可选代码时只跳过对应集成项；未构建桌面端、缺少 WebView2 SDK 缓存时跳过窗口集成测试。
