// Shared, public instructions. No personal paths, credentials or automatic execution.
const common=`请实际帮我配置当前电脑上的 Chatagent / fish with me，完成安装、接入和验证，不要只给我一份让我自己操作的教程。

项目是当前打开的工作区。目标是我指定的聊天；只有一段聊天时使用该段。素材在我另附的文件夹或本地路径里。先从当前工作区和现有配置确认这些信息，找不到时只问缺少的项目路径、素材路径或聊天名，不让我填写技术配置。

开始前读取项目说明，以及当前版本的 packages/dsh-bridge/local-media.mjs、packages/companion-capabilities 下相关实现、apps/service/server.mjs 的语音接口。以实际代码为准，不猜测我的路径、接口或显卡支持。

先记录并备份这段聊天的相关配置，保留原有音色、转文字和其他聊天。优先复用可用环境；需要的新依赖、引擎和模型放进独立目录，采用上游官方来源，核对版本、许可和可取得的摘要，不覆盖系统 Python 或原有模型。不要向无关服务上传我的素材，不使用付费语音接口，不训练新模型。
`;

export const speechAgentTasks={
  basic:{
    title:'转文字 + 免费语音回复',
    note:'不需要准备录音或模型文件。',
    files:['不用准备素材文件'],
    outcome:'配好后，你发语音她能理解，她也能用免费声音回复。',
    instructions:`目标：同时配好“我发语音自动转文字”和“她用免费中文声音回复”。
优先走项目现有的“一键配置语音”，复用 BasicSpeech / PortableAsr 与 Windows 系统中文声音。自动准备缺少的本地转写组件，不要求我手动安装 Python、填写语音接口或选择显卡。
使用实际服务的语音配置接口，先读取当前聊天的 sessionId、revision，再配置并保留已有权限，只增加所需的 chatagent_send_voice。不要只写 settings.json 冒充配置成功。如果媒体桥接尚未接入，先按当前项目配置 mediaAdapter 和正确的 attachmentsRoot，再执行现有流程。
验收：使用固定测试句生成本地语音，实际转写出有效文字，验证语音回复附件的完整性和投递链，并确认重新打开后设置仍然有效。不要调用聊天模型来冒充转文字测试。缺少中文系统声音时，明确说明添加入口或实际失败原因。`
  },
  custom:{
    title:'换成指定的声音说话',
    note:'先准备一段录音；录音里的原话，有就一起放。',
    files:['声音.wav：清楚的单人说话录音，尽量没有背景音乐','可选 原话.txt：录音实际说的内容；没有时让 Agent 先转写'],
    outcome:'Agent 准备说话引擎，接到你选的聊天，并生成一句新音色的试听。',
    instructions:`目标：用我提供的 WAV，让她以这个参考音色回复消息。先用可用的 CPU 方案；显卡加速另做。
读取素材文件夹里的 WAV 和对应文本（如有），核对是否能解码、时长和采样率是否符合所选引擎要求。需要转格式或裁剪时只生成副本，保留原件。没有对应文本时，先通过项目的本地转写准备参考文字；转写不可靠时只向我核对录音原话，不能凭空补编。
检查已有 audio.cpp / CosyVoice3 说话环境和兼容模型。已有则复用并创建新运行副本；缺少时按上游官方说明准备与当前适配器兼容的引擎、GGUF 模型和依赖。先验证引擎独立生成短句，再接入应用。模型格式必须与引擎匹配。
阅读 scripts/prepare-isolated-tts.mjs 与 isolated-tts.mjs 的实际约束。准备脚本只适用于匹配的已有源目录，不是通用下载器。使用新参考录音与 reference_text 生成完整运行副本和文件校验；Windows 原生 AI 语音目录需符合当前 ASCII 路径要求。不得直接替换封存目录中的 WAV 或伪造 manifest 通过校验。
将目标聊天的 mediaOptions.ttsRoot 指向验证通过的新副本，按当前启动方式加载。若当前选择的是免费系统声音，通过现有接口恢复 AI 音色，保留转文字；只为目标聊天开启 chatagent_send_voice，保留其他权限。
验收：实际用新引擎生成一句短语音，检查音频完整性、时长及应用的附件投递链。Windows 免费声音的“试听一句”不能作为定制音色验收。交给我可播放的新音色文件，由我听后确认是否像参考声音。`
  },
  singing:{
    title:'让她用指定音色唱歌',
    note:'准备与唱歌引擎兼容、允许使用的 RVC 音色文件。',
    files:['音色.pth：RVC 音色模型','音色.index：有配套索引就一起放，没有不用乱找','可选：一小段有权使用的歌曲音频，供配置后试唱'],
    outcome:'Agent 检查唱歌环境与模型，完成接入；有试唱素材时先试一小段。',
    instructions:`目标：把我提供的 RVC 模型接入当前聊天的唱歌功能。模型是 .pth，有配套 .index 时一起使用；WAV 录音不是 RVC 模型，不要改后缀冒充，也不要替我训练模型。
检查模型与当前 RVC worker 的版本、采样率、F0 和索引匹配情况。先查看已有唱歌环境，优先复用可用的分离、RVC 变声、混音与编码组件，在新副本配置音色，保留原有唱歌参数与音色以便恢复。
读取 packages/dsh-bridge/local-singing.mjs、packages/companion-capabilities/isolated-singing.mjs 和实际 worker 配置。项目中的 prepare-isolated-singing.mjs 仅复制特定结构的已有环境，不是任意电脑的通用下载安装器；源代码包不一定包含它。缺少环境时，按实际适配器与上游说明准备兼容组件；如果当前版本无法接入，就明确指出具体缺口，不要伪造配置成功，也不要要求我自己安装一串 Python 包。
为新环境重新生成真实文件校验、runtimePins 和 recipeDigest 等实际需要的记录，核对当前聊天的 scope。只将该聊天的 mediaOptions.singingFile 指向新配置，按现有方式加载，并保留其他工具权限，只开启所需的 chatagent_singing__control。说话用的 ttsRoot、系统声音和转文字保持可用。
有我提供的试唱素材时，仅用短段验证分离、变声、混音、输出完整性和应用投递链；不自动下载整首歌曲或发送完整歌曲。没有试唱素材时完成环境与工具检查，将“试唱待选曲”列为待验证，不宣称已经唱歌通过。
显卡加速先沿用已验证配置；不把 DirectML 配置改成 CUDA 就当作支持 N 卡。给我短试听文件，由我确认音色。`
  },
  gpu:{
    title:'让显卡加快生成',
    note:'先让定制说话或唱歌正常工作，再做这一步。',
    files:['不用准备新文件，使用已配置的说话或唱歌环境'],
    outcome:'Agent 识别显卡和兼容性，测试实际速度，并保留原来的可用方案。',
    instructions:`目标：检查并配置已有 AI 说话或唱歌的显卡加速。先识别显卡完整型号、驱动和现有引擎，区分 AMD（A 卡）、NVIDIA（N 卡）与其他设备；免费 Windows 系统声音不需要显卡加速。
说话和唱歌分别检查。以当前代码的支持为准：现有 AI 说话适配器接受 CPU 或符合约束的 HIP，不能只将 backend 改为 cuda；现有唱歌环境的 DirectML 也不等于通用 CUDA 环境。当前适配器不支持时明确给出缺口，保留能用的方案，不伪装成功。
兼容时，在独立副本中准备官方要求的驱动或依赖，先用相同短句或同一试唱短段记录原方案耗时，再运行显卡方案。核对实际使用的设备、可播放输出、耗时和显存占用。按当前接口生成完整校验并接入原目标聊天，保留转文字、原音色和其他权限。
分别报告说话、唱歌是否支持以及实际测试速度；只通过了其中一项，就只报告那一项。失败时恢复原配置，不覆盖可用的 CPU 环境。`
  }
};

export function speechAgentPrompt(kind){
  if(!Object.hasOwn(speechAgentTasks,kind))throw Error('UNKNOWN_SPEECH_TASK');
  return common+'\n'+speechAgentTasks[kind].instructions+`\n\n完成后只用简洁中文告诉我：配好了哪些、哪里还没验证、试听文件在哪、回到应用怎么用、如何恢复原配置。没有真正通过的环节明确写“未通过”或“待验证”，不要用改了配置文件代替实际成功。`;
}
