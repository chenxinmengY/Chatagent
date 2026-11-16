# 第三方与来源说明

Chatagent 没有自行研发本文列出的模型、记忆评分或编解码算法。外部依赖的许可不由 Chatagent 自有代码许可证替代。

| 组件 | 当前依据与用途 | 分发方式 |
| --- | --- | --- |
| [DSH](https://github.com/deepseek-ai/deepseek-harness) | 本地已验证 @deepseek-ai DSH 系列 0.2.1-rc.3；包声明 MIT。Cordis 4.0.5。会话、工具、上下文与执行循环 | 用户提供 SDK，不随源码包复制 |
| [dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory) / Yuuyuko-uu | 1.5.0，Yuuyuko-uu 插件许可 1.2。长期记忆、召回、remember | 外置；本地适配副本完整保留原 LICENSE 和 package.json，并写入修改说明。再次分发副本须遵守其署名、首页来源及衍生许可条件 |
| [silk-wasm](https://github.com/idranme/silk-wasm) / idranme | 3.7.1，MIT；SILK 编解码 | vendor/silk-wasm 内含原 LICENSE、包声明、WASM；文件摘要见 vendor/integrity.json |
| [country-region-data](https://github.com/country-regions/country-region-data) | 固定提交 eb257cfebb5f352368befcd3474ffdefe5407350；地区数据 | 保留 packages/conversation/region-data/LICENSE.txt 和 source.json |
| [dsh-meme](https://github.com/yyh-001/dsh-meme) / yyh-001、Selfloom contributors | 0.1.78，提交 32e0282b9a3aa4fb4793ad836e3c17b4180dc2c4，MIT；改编其关键词、中文二元词检索思路，接入 Chatagent 原件库、收藏及持久投递 | 保留 packages/stickers/vendor/dsh-meme-LICENSE；未将上游网页表情标记直接用于聊天 |
| [WeChatAgent](https://github.com/sourcepro5/WeChatAgent) / Derpyu520、qq-bridge / QSH contributors 等 | 对照公开快照 `5cdedddc60936c550ce5c02558eb025a5350f48e`；复用、改编插件 API、扩展运行时及局部网络校验，叠加此前本地集成的课表、提醒、媒体适配 | 仅挑出的代码位于 `packages/local-user-plugins`，保留完整 `WeChatAgent-LICENSE`、逐文件来源与修改状态；无微信传输、Hook、账号、预设人格或运行资料 |
| [qq-bridge](https://github.com/Derpyu520/qq-bridge) / Derpyu520、QSH contributors | MIT；经 WeChatAgent 复用的 `safe-fetch.js` | `packages/local-user-plugins/components/qq-bridge/LICENSE` 保留原通知；未引入 QQ/微信传输层或其依赖 |
| [Applio](https://github.com/IAHispano/Applio/tree/67a38f6abab3e90a55efa534ea3185a222c102f0) / AI Hispano | 固定提交 `67a38f6abab3e90a55efa534ea3185a222c102f0`，MIT；RVC 推理接口、分块合成与张量约定 | 外置源码与模型；本仓库提供适配代码，保留 [上游许可链接](https://github.com/IAHispano/Applio/blob/67a38f6abab3e90a55efa534ea3185a222c102f0/LICENSE) |
| [Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) / liujing04、源文雨、Ftps 等 | RVC 算法来源，MIT；当前调用的是上述 Applio 环境 | 不分发原项目源码、权重、ContentVec/RMVPE 资产；各模型单独遵循自身许可 |
| [肥鱼声音服务](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/tree/76774b499f7d306454562d56348dd63399b6d7e8) / Esmerubphire | 本机 RVC 兼容层基线 `76774b499f7d306454562d56348dd63399b6d7e8`；运行时调用 `feiyu_runtime.common` | 作者代码的 [NOTICE](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/76774b499f7d306454562d56348dd63399b6d7e8/NOTICE.md) 没有授予通用开源许可；本仓库没有复制该代码、声库、参考音频或安装包，不按 MIT 重新授权 |
| [PyTorch](https://github.com/pytorch/pytorch)、[DirectML](https://github.com/microsoft/DirectML)、[FAISS](https://github.com/facebookresearch/faiss)、[SciPy](https://scipy.org/)、[soundfile](https://github.com/bastibe/python-soundfile)、[pilk](https://github.com/foyoux/pilk) | 可选换声/点歌环境的计算、GPU 合成、检索、音频和 SILK 编码依赖 | 均外置，未分发 wheel、DLL、FFmpeg 或模型；按所安装版本随附的具体许可使用，不能由本仓库的 MIT 代替 |
| dsh-gemini-pool | 可选旧订阅媒体适配器调用用户已安装的插件，兼容基线 0.7.13 | 不复制插件或账户；代码以固定摘要校验外部模块，实际许可和版本以安装包为准 |
| [bilibili-api-python](https://github.com/Nemo2011/bilibili-api) | 可选音视频来源工具调用；本地包元数据声明 GPL-3.0-or-later | 外置，不分发 Python 包或其源码；不要把依赖它的完整运行环境当作纯 MIT 安装包再分发 |
| [wechat_meme_export](https://github.com/Ant39140/wechat_meme_export) / Ant39140 | 提交 27dd2eb4faa15cd9f054d53c0d4435d03f984864，MIT；本次用户微信表情只读导出工具，新增 4.2.0.13 适配并以数据库 HMAC 和完整性检查验证 | 仅本地 verification 工具及原 LICENSE，不随应用运行或源码发布包分发；私有数据库、密钥及表情不随仓库分发 |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)、[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 本地转文字；SenseVoice int8 固定模型提交与 sherpa-onnx/core 2.0.1 | 点击一键配置后从固定上游地址下载并检查 SHA-256；源码包不含权重或运行库。安装保留模型许可指引、运行库许可和来源清单；具体模型使用遵循其上游条款 |
| [Python](https://www.python.org/)、[NumPy](https://numpy.org/) | 便携 Python 3.13.17 与 NumPy 2.2.6，独立运行转写 | 用户点击后从 python.org / PyPI 下载；保留各自许可，不修改系统 Python |
| [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg)、[FFmpeg](https://ffmpeg.org/) | imageio-ffmpeg 0.6.0 Windows wheel 内的 FFmpeg，用于本地音频解码 | 点击后下载并核对摘要，保留原 wheel 的许可及来源说明；FFmpeg 二进制适用其具体构建许可，源码包不含二进制 |
| [CosyVoice](https://github.com/FunAudioLLM/CosyVoice)、[audiocpp](https://github.com/0xShug0/audio.cpp) | 既有 TTS 外部运行环境；GGUF、推理工具不是 Chatagent 原创 | 不随包分发；来源和版本以实际部署清单为准，未确认的运行时不得并入发布包 |
| [Node.js](https://nodejs.org/) | Windows 发行包内置 24.22.2 x64，用于本地服务 | 核对官方 ZIP 摘要，保留完整 Node-LICENSE.txt（含 Node.js 与所含第三方组件许可） |
| [NSIS](https://nsis.sourceforge.io/) | 3.12，Windows 安装与卸载程序构建 | 核对官方 ZIP 摘要，保留 NSIS-LICENSE.txt；编译器不随应用安装 |
| Microsoft WebView2 | Windows 桌面窗口；构建固定 SDK 1.0.4314.35 并校验下载摘要 | 构建产物保留 SDK LICENSE 和 NOTICE；发行包包含经微软签名验证的 Evergreen 引导程序，缺少 Runtime 时联网安装，适用微软许可 |
| Android SDK / OpenJDK | Android 构建工具，非应用自研部分 | 不随源码包或 APK 打包构建工具 |
| [AutoStarter](https://github.com/judemanutd/AutoStarter/blob/master/autostarter/src/main/java/com/judemanutd/autostarter/AutoStartPermissionHelper.kt) | vivo / iQOO 自启动管理的已知系统组件名称参考；用于尝试打开系统设置 | 未引入该库或复制其实现；系统页面可能不存在或拒绝访问，届时回退到标准系统设置 |

`packages/companion-capabilities/vendor/singing`、`vendor/bili`、`vendor/voice-intent.mjs` 来源于本项目所有者既有 Cyberwife 工程的唱歌、阅读和语音意图适配代码。抽取时去除了生产连接、改为注入服务；逐文件原路径和摘要保留于 `vendor/integrity.json`。这部分是业务编排代码，不能用来宣称自行实现其调用的模型或底层算法。

源目录中的迁移适配器仍可使用用户显式导入的 WeChatAgent 插件副本；本版本另将必要插件的代码子集整理到 `packages/local-user-plugins`，其运行资料和私有配置不随源码分发。AstrBot 适配器依据 [官方导出实现](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/dashboard/services/conversation_service.py) 的会话 JSONL 字段做格式转换，没有复制 AstrBot 源码；AstrBot 项目采用 AGPL-3.0，格式互操作不会把其源码纳入本仓库，其字段可能随上游变化。

`packages/dsh-bridge/import-timetable.py` 复用项目所有者 Cyberwife 工程 `course-query/import-timetable.py` 的日期课表 Excel 解析实现，增加了文件展开大小限制。它只使用 Python 标准库；个人课表、Excel 源文件和已导入课程均保留在用户资料目录，不随源码分发。

本仓库自有代码采用 MIT 许可证；本文列出的第三方组件和外部运行环境保留各自的许可证与授权条件。鱼插件、模型权重和私人资料不随仓库分发。

`rvc_boundary.py`、随附的进程所有权与音频片段辅助代码抽取自项目所有者此前的本地集成；它们负责运行编排与边界验证，不是 RVC、SILK 或 DirectML 算法的原创实现。角色模型的训练来源授权与进一步分发权未在本次发布中确立，因此角色权重、索引、训练素材和试听一律排除。参考音频的来源链路也不作为角色本人原声的证明。

本次核对的外置环境元数据：PyTorch `2.11.0+cpu`（BSD-3-Clause）、FAISS CPU `1.14.3`（MIT）、SciPy `1.17.1`（BSD）、soundfile `0.14.0`（BSD-3-Clause）、torch-directml `0.2.5.dev240914`（MIT）、onnxruntime-directml `1.22.0`（MIT）。[pilk](https://github.com/foyoux/pilk/blob/main/LICENSE) 是 GPL-3.0，FFmpeg 和 libsndfile 等底层库还各有许可；本次没有将它们打包。audio.cpp 的引擎许可为 [Apache-2.0](https://github.com/0xShug0/audio.cpp/blob/main/LICENSE)，CosyVoice 模型权重及派生声库另行核对模型卡。本表是当前接口与本地版本的来源记录，不承诺未来版本许可相同。
