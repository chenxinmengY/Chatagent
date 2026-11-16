# 语音、换声和 DirectML

基础语音走「设置 → 语音 → 一键配置语音」：本地 SenseVoice 转写和 Windows 中文声音，不需要角色模型。高级接口独立配置；本仓库提供编排代码、CPU/DirectML 边界辅助代码及配置模板，不包含可直接运行的完整 RVC/分离环境，也不会自动下载角色声库。

## 可选 RVC 环境

复制 [rvc-profile.example.json](../examples/rvc-profile.example.json) 为仓库外的私有 JSON。模板中的路径和 SHA-256 必须替换成自己的文件与摘要。只加载可信且有权使用的权重；示例文件名不代表随包提供模型。将该文件的绝对路径写入 DSH 桥接 `mediaOptions.rvcVoiceProfile`，同时配置 `ttsRoot`，才能给普通 TTS 叠加换声。

当前兼容接口需要以下布局：

| 配置 | 需要的内容 |
| --- | --- |
| `root` | 自己的权重、FAISS 索引、`settings.json` 以及输出 `runs` 目录 |
| `rvcRoot` | `source/Applio`、`runtime.cpu.json` 和 `vendor/server/feiyu_runtime` |
| `python` | 安装 Applio、PyTorch、torchaudio、FAISS、NumPy、SciPy、soundfile 的隔离 Python |
| `launcherPython` | Windows 上实际的 Python 解释器，避免 venv 重定向入口；用于 Job Object 进程管理 |
| `separation` | 可选点歌环境，包含 `dml-env/Scripts/python.exe` 和 `run-local-separation.py` |
| `singingDml` | 可选合成环境的 `python` 和 `adapter` 编号；删除该字段可用 CPU 合成 |
| `codecPython` | 片段输出用的 Python，需安装 `pilk`；同时需要 PATH 中的 FFmpeg |

`ownershipModule` 可以省略，使用本仓库随附的 Windows 进程管理模块。`rvc_boundary.py` 在本仓库中随附，无需再复制本机研究目录。片段切分、SILK 编码辅助脚本也随附；如 `root` 中已有旧脚本则保留该入口，也可用 `segmentsScript` 显式指定。

本机兼容基线是 Applio `67a38f6abab3e90a55efa534ea3185a222c102f0`，搭配 Esmerubphire 肥鱼运行时 `76774b499f7d306454562d56348dd63399b6d7e8` 的校验与兼容层。后者的作者代码**没有通用开源许可**，因此本仓库没有复制它、没有代发安装包；需要自行核对其 [来源及分发声明](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/76774b499f7d306454562d56348dd63399b6d7e8/NOTICE.md)。也没有提供该外置环境的完整一键部署保证。`run-local-separation.py` 的输入参数和输出契约见 `rvc-voice.py`：输入绑定 SHA-256，输出 `runs/<job-id>/manifest.json`，包含 lead、instrumental、harmony 的路径、`sourceSha256` 和 `sourceFrames`。分离模型和环境需自行准备。

DirectML 只承担 RVC 的分块人声合成；特征提取、音高、FAISS、随机数序列和谐波源仍在 CPU。代码按 v2、40 kHz、768 维特征、FP32、单批次模型约束验证，不保证任意 RVC 模型均能运行。CPU 与 DirectML 使用不同的隔离环境；不要为此替换正在运行项目的 Python 或依赖。

内部仍有 `mansui` 引擎标识和 UI 名称以兼容已有配置，它们不表示本仓库附带、授权或推荐任何角色模型。原声素材、角色权重、索引、训练集、参考音频和试听成品均未发布。代码的 MIT 许可不授予这些内容的使用或分发权。

## 其他语音组件

TTS 外部接口来自 CosyVoice3 / audio.cpp；已有 `prepare-isolated-tts.mjs` 面向兼容的本地 `cosyvoice3-feiyu` 配置，不是通用音色下载器。参考音频和 GGUF 必须由使用者自行准备。各模型、运行库、解码器的许可见 [第三方说明](../THIRD_PARTY_NOTICES.md)。
