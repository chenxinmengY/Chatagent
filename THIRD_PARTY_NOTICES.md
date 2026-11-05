# 第三方与来源说明

Chatagent 没有自行研发本文列出的模型、记忆评分或编解码算法。外部依赖的许可不由 Chatagent 自有代码许可证替代。

| 组件 | 当前依据与用途 | 分发方式 |
| --- | --- | --- |
| [DSH](https://github.com/deepseek-ai/deepseek-harness) | 本地已验证 @deepseek-ai DSH 系列 0.2.1-rc.3；包声明 MIT。Cordis 4.0.5。会话、工具、上下文与执行循环 | 用户提供 SDK，不随源码包复制 |
| [dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory) / Yuuyuko-uu | 1.5.0，Yuuyuko-uu 插件许可 1.2。长期记忆、召回、remember | 外置；本地适配副本完整保留原 LICENSE 和 package.json，并写入修改说明。再次分发副本须遵守其署名、首页来源及衍生许可条件 |
| [silk-wasm](https://github.com/idranme/silk-wasm) / idranme | 3.7.1，MIT；SILK 编解码 | vendor/silk-wasm 内含原 LICENSE、包声明、WASM；文件摘要见 vendor/integrity.json |
| [country-region-data](https://github.com/country-regions/country-region-data) | 固定提交 eb257cfebb5f352368befcd3474ffdefe5407350；地区数据 | 保留 packages/conversation/region-data/LICENSE.txt 和 source.json |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)、[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | ASR 外部运行环境；识别适配器调用，不含其权重和运行库 | 用户另行准备；分发具体权重/运行库时须核对实际版本许可证 |
| [CosyVoice](https://github.com/FunAudioLLM/CosyVoice)、[audiocpp](https://github.com/0xShug0/audio.cpp) | 既有 TTS 外部运行环境；GGUF、推理工具不是 Chatagent 原创 | 不随包分发；来源和版本以实际部署清单为准，未确认的运行时不得并入发布包 |
| Microsoft WebView2 | Windows 桌面窗口；构建固定 SDK 1.0.4314.35 并校验下载摘要 | 构建产物保留 SDK LICENSE 和 NOTICE；用户安装 Runtime |
| Android SDK / OpenJDK | Android 构建工具，非应用自研部分 | 不随源码包或 APK 打包构建工具 |

`packages/companion-capabilities/vendor/singing`、`vendor/bili`、`vendor/voice-intent.mjs` 来源于本项目所有者既有 Cyberwife 工程的唱歌、阅读和语音意图适配代码。抽取时去除了生产连接、改为注入服务；逐文件原路径和摘要保留于 `vendor/integrity.json`。这部分是业务编排代码，不能用来宣称自行实现其调用的模型或底层算法。

源目录中的迁移适配器还会使用用户显式导入的 WeChatAgent 插件副本；它们在用户资料目录中，本源码包不包含这些插件及其私有数据。AstrBot 适配器依据 [官方导出实现](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/dashboard/services/conversation_service.py) 的会话 JSONL 字段做格式转换，没有复制 AstrBot 源码；其格式可能随上游变化。

`packages/dsh-bridge/import-timetable.py` 复用项目所有者 Cyberwife 工程 `course-query/import-timetable.py` 的日期课表 Excel 解析实现，增加了文件展开大小限制。它只使用 Python 标准库；个人课表、Excel 源文件和已导入课程均保留在用户资料目录，不随源码分发。

本仓库自有代码采用 MIT 许可证；本文列出的第三方组件和外部运行环境保留各自的许可证与授权条件。鱼插件、模型权重和私人资料不随仓库分发。
