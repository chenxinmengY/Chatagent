# 可选课表、提醒与媒体插件代码

`packages/local-user-plugins` 保存从既有运行环境挑出的代码：插件 API、课表查询、事项提醒、媒体账本和音乐/原音适配层。它来自 WeChatAgent 及项目所有者此前的 Cyberwife 集成，来源快照和修改状态见其中的 `SOURCE.json`；完整原许可证一并保留。没有复制运行目录的课程、账号、绑定、提醒状态、媒体记录、凭据或人格。

## 新建独立插件目录

先启动桥接，读取其根目录 `identity.json` 的 `sessionId`。然后运行：

```powershell
node scripts/prepare-local-plugins.mjs C:/Chatagent/private/local-plugins chatagent-00000000-0000-0000-0000-000000000000
```

替换示例会话 ID。目标必须是不存在的绝对路径。工具复制已审查的代码、创建随机本地账户作用域，初始关闭插件、提醒与自动媒体。`wechat:private:1` 是兼容旧插件 API 的本地键，不需要填写或发现真实微信账号。

在 DSH 桥接插件的配置中设置 `localPluginsRoot` 指向新目录，再重启该桥接。插件按聊天隔离，不要把已有真实微信的运行根目录直接接进来。新聊天、人格及工具授权仍由 Chatagent 管理。

## 启用课表与提醒

课表初始为空。先在 Chatagent 课表页导入自己的日期课表，或准备符合 `import-timetable.py` 契约的文件；原始 Excel 不要提交。`plugins/course-query/assets/timetable.json` 是运行资料，已被 Git 忽略。两项插件都需要在独立目录 `config/plugins.json` 配置许可，并在对应聊天中授权工具。下面的 `generation` 填写一个新 UUID（PowerShell 可执行 `[guid]::NewGuid().ToString()`）；它标记这次授权，撤销后重新启用时应重新生成。

```json
{
  "version": 1,
  "plugins": {
    "daily-reminders": {
      "enabled": true,
      "generation": "REPLACE_WITH_NEW_AUTHORIZATION_UUID",
      "permissions": ["storage"],
      "chats": ["wechat:private:1"],
      "settings": {}
    }
  }
}
```

提醒还需要在新目录的 `chatagent-binding.json` 显式设置 `remindersEnabled: true`，并给该聊天授权 `daily-reminders__manage`。提醒只有在宿主运行、会话绑定和授权满足时发送；本机保存回执不代表手机已收到。课表查询插件用相同配置结构，ID 为 `course-query`，工具为 `course-query__query`。

## 高级媒体

媒体、原音理解和点歌的代码保留，但完整功能还需要自己的媒体接口、用户授权和独立运行环境。优先使用 Chatagent 的媒体连接设置；旧订阅适配器保留为兼容路径，使用前显式设置 `CHATAGENT_DSH_PACKAGE` 为 DSH 的 `package.json`，可用 `CHATAGENT_DSH_HOME` 和 `CHATAGENT_GEMINI_POOL_MODULE` 指定自己的配置位置。它调用已安装的 dsh-gemini-pool，不分发其代码，也不带入开发者的账号或订阅配置。

角色换声和 DirectML 的依赖与边界见 [VOICE-RVC.md](VOICE-RVC.md)。配置模板不能替代模型、插件及素材自身的许可证。
