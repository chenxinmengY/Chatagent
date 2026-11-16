'use strict';
import {speechAgentTasks,speechAgentPrompt} from './speech-agent-prompts.js';
// Read-only illustrated guide: no model calls, uploads or saved progress.
if(location.pathname==='/speech-guide'){
  document.querySelector('.preview-tag').textContent='使用教程';
  document.querySelector('.page-footer span:last-child').textContent='照着示意图，在软件里操作就好。';
}
const paths={
  home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  chat:'<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/><path d="M8 9h8M8 13h5"/>',
  archive:'<path d="M4 8h16v13H4zM3 3h18v5H3zM9 12h6M12 12v5m-3-2 3 3 3-3"/>',
  plugin:'<path d="M9 3H4v6a3 3 0 1 1 0 6v6h6a3 3 0 1 1 6 0h5v-6a3 3 0 1 1 0-6V3h-6a3 3 0 1 1-6 0Z"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  voice:'<path d="M11 5 6 9H3v6h3l5 4V5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'
};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
const heading=(kicker,title,description)=>`<div class="page-heading"><p class="eyebrow">${kicker}</p><h1 id="page-title" tabindex="-1">${title}</h1><p>${description}</p></div>`;
const step=(number,title,body,result='')=>`<li class="step"><span class="step-number" aria-hidden="true">${number}</span><div><h3>${title}</h3>${body}${result?`<div class="result-line">${icon('check')}<span>${result}</span></div>`:''}</div></li>`;
const rail=(title,body,blue=false)=>`<section class="rail-card${blue?' blue':''}"><h3 class="rail-title">${blue?icon('info'):''}${title}</h3>${body}</section>`;
const faq=(title,body)=>`<details class="faq"><summary>${title}</summary>${body}</details>`;
const button=(label,target,primary=false)=>`<a class="${primary?'primary':'secondary'}" href="#${target}">${label}${primary?icon('arrow'):''}</a>`;
const end=(note,back,next,label)=>`<div class="lesson-footer"><p>${note}</p><div class="footer-buttons">${button('返回',back)}${button(label,next,true)}</div></div>`;
const official=(label,url)=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;

function start(){return heading('01 / 先认识彼此','先开始一段聊天','电脑负责连接 DSH 和保存资料。先让第一句回复顺利到达，再按需添加其他能力。')+`<div class="guide-layout"><section class="paper"><ol class="steps">${step(1,'准备好 DSH 和聊天连接','<p>打开已安装的 DSH，配置自己的模型账号，确认所选模型可以使用。fish with me 需要加载专用桥接，才能与 DSH 会话连接。</p><p>还没有连接过？先阅读<a href="#plugins">「接入 DSH 插件」中的桥接准备步骤</a>。只读完指南不会自动完成连接。</p>','DSH 已连接，专用会话中有可用模型。')}${step(2,'选择聊天和人格','<p>打开电脑端「聊天」，进入已有聊天；需要新的角色时，点击「添加聊天」，填写名称并选择人格卡。</p><span class="path">聊天 → 设置此聊天 → 基本设置</span><p>确认人格与回复设置。各聊天使用独立会话，模型在对应的 DSH 会话中选择。</p>','能进入所选聊天，名称和人格正确。')}${step(3,'打个招呼，确认回复','<p>回到聊天，发送一句「你好，介绍一下自己」。收到回复后，说明这一段聊天的连接已经可用。</p><p>如果没有回复，先检查电脑端的连接提示、DSH 是否运行、当前会话是否选择了模型。插件和资料迁移可以稍后再配置。</p>','聊天中出现实际回复；这一步会使用你的模型额度。')}</ol></section><aside class="help-rail">${rail('不必一次配置完','<p>先连接模型即可开始文字聊天。旧资料、记忆、语音和插件按需添加。</p>',true)}${rail('关于资料','<p>聊天与附件保存在自己的电脑。手机通过已配对的设备入口同步。</p><p>模型请求会按你的 DSH 配置发送给所选模型服务。</p>')}${rail('已经在使用了？','<p>可以直接选择左侧的迁移、插件或手机指南，不需要从头走一遍。</p>')}</aside></div>`+end('本页是操作说明，不会替你发送测试消息。','welcome','migration/astrbot','了解资料迁移');}

function migration(kind){const astr=kind==='astrbot';return heading('02 / 把过往带来','搬来聊天与记忆','先选资料来源，再按步骤导出和导入。迁移前保留原件，每次只处理你选定的一段聊天。')+`<nav class="source-switch" aria-label="选择资料来源"><a href="#migration/astrbot" ${astr?'aria-current="page"':''}>从 AstrBot 搬来</a><a href="#migration/wechatagent" ${!astr?'aria-current="page"':''}>从 WeChatAgent 搬来</a></nav><div class="note"><strong>聊天记录和长期记忆，需要分别处理。</strong><small>聊天是双方说过的原文；长期记忆是插件保存的事实与偏好。导入聊天不会自动提炼、启用或替换长期记忆。</small></div>${astr?astrbot():wechatagent()}<h2 class="help-title">搬家前，你可能还想知道</h2>${faq('聊天、人设、记忆、附件分别会怎样？','<ul><li>聊天：支持的原文进入聊天历史，保留来源；缺少消息时间时标为「时间不详」。</li><li>人设与日记：先保存为导入档案，供你核对，不自动覆盖当前人格。</li><li>长期记忆：只有已适配的引擎和版本才能写入当前记忆库；无法转换的内容保留原件。</li><li>附件：便携资料包不包含附件原文件；图片、语音等需要另行采集、校验和关联。仅有链接不代表原文件已搬来。</li></ul>')}${faq('旧任务和提醒会自动再跑一次吗？','<p>资料导入不会重放旧任务，也不会自动恢复提醒的执行。需要继续使用的提醒，应在新会话中重新核对并设置。</p>')}${faq('原插件没有导出按钮怎么办？','<p>先查该插件说明，确认数据目录和备份方式，保留包含原文、角色归属及版本信息的稳定副本。不同插件可能使用数据库、JSON 或外部服务；不能只把向量索引改个文件名后导入。暂不兼容时先保存原件，不让迁移结果冒充已经可召回的长期记忆。</p>')}<div class="lesson-footer"><p>先检查，再确认；不兼容的部分会单独说明。</p><div class="footer-buttons">${button('返回首页','welcome')}${button('接着了解插件','plugins',true)}</div></div>`;}

function astrbot(){return `<div class="guide-layout"><section class="paper"><ol class="steps">${step(1,'在 AstrBot 导出会话 <span class="pill">聊天记录</span>','<p>打开 AstrBot 控制台，进入「会话管理／对话管理」；新版入口可能在「数据与日志 → 会话」。勾选要搬来的会话，点击「导出」，保存下载的 <strong>.jsonl</strong> 文件。</p><p>一个文件可以包含多个会话，导入时再选择其中一个。保留原文件，不需要手工编辑。</p>','拿到 AstrBot 的会话 JSONL 文件。')}${step(2,'另行导出长期记忆 <span class="pill amber">按插件确认</span>','<p>如果使用了记忆插件，进入 AstrBot 的插件管理，记下<strong>插件名称和版本</strong>，按该插件说明导出记忆，或备份它的数据。</p><p>AstrBot 会话导出不等于该插件记忆的完整导出。目前这里没有任意 AstrBot 记忆插件的通用导入器；这部分需要单独适配。</p>')}${step(3,'在 fish with me 选择文件','<span class="path">电脑端：设置 → 导入与备份 → 导入其他聊天资料</span><p>「文件来自哪里」选择 <strong>AstrBot 控制台导出（JSONL）</strong>，给来源起个名字，例如「家里的 AstrBot」。选择导出的文件，再选择要导入的对话。</p><p>当前文件上限为 32 MiB。文件较大时，在来源端按会话分批导出。</p>')}${step(4,'检查内容，再确认导入','<p>点击「检查导入内容」，核对新增、重复、冲突、时间不详和附件情况。遇到冲突先核对原件，处理后重新检查。</p><p>检查通过后点击「确认导入」，再到对应聊天中核对旧记录。JSONL 中的工具与其他上下文只存档，不执行。</p>','聊天已导入；长期记忆是否可用，需要另行验证。')}</ol></section><aside class="help-rail">${rail('当前支持到哪里','<p><strong>聊天 JSONL：已有导入入口。</strong></p><p><strong>插件长期记忆：需要逐项适配。</strong>插件名称与版本不同，处理方式也可能不同。</p>',true)}${rail('记得保留这几份','<ul class="mini-list"><li>AstrBot 会话 JSONL</li><li>记忆插件名称与版本</li><li>插件原生记忆导出／备份</li><li>需要保留的附件原件</li></ul>')}${rail('来源说明',`<p>入口名称可能随 AstrBot 版本变化。</p>${official('AstrBot 官方使用说明','https://github.com/AstrBotDevs/AstrBot/blob/master/docs/en/use/webui.md')}${official('官方会话导出实现','https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/dashboard/services/conversation_service.py')}`)}</aside></div>`;}

function wechatagent(){return `<div class="note amber"><strong>当前需要先采集并转换资料。</strong><small>已有针对已验证结构的迁移脚本；尚未提供通用的「选择 WeChatAgent 目录，一键导入」入口。原目录、ZIP 或采集目录不能直接当 JSON 资料包上传。</small></div><div class="guide-layout"><section class="paper"><ol class="steps">${step(1,'找到工作区和 DSH 记忆','<p>这里指 <strong>sourcepro5/WeChatAgent</strong> 这一项目。新版的配置与运行资料通常在安装根目录的 <strong>data/workspace</strong>；旧版按实际数据位置查找。</p><p>外部 DSH 的数据独立管理。先确认原聊天对应的 DSH 会话，以及记忆插件的数据目录和版本，不能只备份 WeChatAgent 程序文件。</p>')}${step(2,'为目标聊天生成资料副本','<p>按原应用或插件支持的方式备份，分别保留聊天、人设、日记、记忆及附件。采集时明确账号和聊天范围，保留记忆中的删除、修订状态。</p><p>正在使用的数据库需要一致性备份，不能只复制一个运行中的数据库文件。原系统的文件和会话保持独立，迁移写入新的目录。</p>','原件已保留，能确认资料属于哪段聊天。')}${step(3,'核对版本，转换成可导入 JSON <span class="pill amber">需适配</span>','<p>使用与来源版本匹配的转换器，将资料映射到 fish with me 支持的 JSON 结构，并检查记录数量、来源、时间与附件引用。</p><p>现有 <strong>prepare-standby.mjs</strong> 是针对已验证结构的采集工具，不是通用转换器；其采集目录还需要后续整理与转换。这一步目前需要按具体版本处理。</p>')}${step(4,'检查并导入转换后的资料','<span class="path">设置 → 导入与备份 → 文件来自哪里 → fish with me 资料包 / 转换后的 JSON</span><p>选择转换后的 JSON，点击「检查导入内容」。核对新增、重复、冲突和缺失项后，再点击「确认导入」。人设和日记先供核对，不自动覆盖当前配置。</p>')}${step(5,'单独迁入并验证长期记忆','<p>目前已有<strong>鱼的记忆 1.5.0 原生条目</strong>适配器，需要在 DSH 侧为目标新会话配置对应的记忆引擎及迁移适配器。上传档案本身不等于记忆已经启用。</p><p>其他版本、群友记忆或其他记忆引擎不能直接套用。迁入后核对数量、删除状态与角色归属，再用已知事实验证召回。</p>','旧聊天可查，兼容的记忆能由新会话正确召回。')}</ol></section><aside class="help-rail">${rail('哪些已有，哪些待补齐','<p><strong>已有：</strong>转换后 JSON 导入、特定结构采集、鱼 1.5.0 记忆适配。</p><p><strong>待补齐：</strong>通用目录选择、自动版本识别及其他记忆引擎转换。</p>',true)}${rail('聊天与记忆别混在一起','<p>普通聊天记录只进入历史档案。若以后选择从旧聊天提炼新记忆，那是额外的模型任务，需另行确认范围和用量。</p>')}${rail('来源说明',`<p>WeChatAgent 自身迁移和迁入 fish with me 是两个流程。</p>${official('WeChatAgent 数据位置说明','https://github.com/sourcepro5/WeChatAgent/blob/main/docs/DATA_STORAGE.md')}`)}</aside></div>`;}

function plugins(){return heading('03 / 按需添加能力','把 DSH 的能力接进来','插件在 DSH 安装和运行，fish with me 连接专用会话，再为这段聊天选择可使用的工具。')+`<div class="note"><strong>安装插件、接通会话、允许使用，是三个步骤。</strong><small>fish with me 的「导入插件」入口用于导入配置文件；它不会替你安装插件程序或补齐运行环境。</small></div><div class="guide-layout"><section class="paper"><ol class="steps">${step(1,'在 DSH 安装并配置插件','<p>在 DSH 插件管理中，按插件作者说明安装、启用并填写参数。模型账号、插件密钥与数据位置在 DSH 管理。</p><p>先确认插件成功加载、兼容当前 DSH 版本，并且能用于 fish with me 的专用会话。</p>','DSH 显示插件已加载，没有缺少依赖的报错。')}${step(2,'接通 fish with me 专用桥接','<p>在 DSH 的用户补丁中添加本项目 <strong>packages/dsh-bridge/index.mjs</strong>，使用绝对 file URL；为它配置新的专用资料目录、工作目录和令牌文件。</p><p>客户端与桥接使用同一令牌文件，连接地址指向桥接的本机端口。按下方「首次桥接配置」说明准备，再在 DSH 加载桥接。</p><p>桥接会关联专用会话。在对应 DSH 会话选择模型。旧版工作区可能仍显示「Chatagent」，请按专用会话确认。</p>','桥接与客户端已连接，目标会话身份对应。')}${step(3,'给当前聊天授权工具','<span class="path">fish with me → 聊天 → 设置此聊天 → 能力与权限</span><p>先取消<strong>「仅看已启用」</strong>，再刷新、搜索插件。勾选这段聊天需要的工具，点击「保存此会话」。</p><p>新出现的工具默认关闭；每段聊天分别授权。DSH 本身的权限限制仍然生效。</p>','所需工具出现在当前聊天的已启用列表。')}${step(4,'按能力做一次小验证','<p>搜索插件可以问一条公开信息；记忆插件可以保存一个测试偏好，再在后续问题中核对召回；提醒插件需要核对通知是否送达当前聊天。</p><p>工具可调用不代表自动记忆或通知已经适配。若插件依赖微信发送、专用页面或本地模型，还要完成对应接入。</p>','功能实际完成，结果归属正确的聊天。')}</ol></section><aside class="help-rail">${rail('记忆插件还需要什么？','<p>确认它绑定的是当前聊天的 DSH 会话／记忆库。自动召回和保存依赖插件生命周期，并不只靠工具开关。</p>',true)}${rail('手机也要安装吗？','<p>DSH 和插件运行在电脑上。手机配对后使用已接入的能力，不需要在手机重装一份 DSH 插件。</p>')}${rail('版本说明','<p>项目文档记录的桥接核验版本为 DSH 0.2.1-rc.3；其他版本需要核对接口，不能默认全部兼容。</p>')}</aside></div><h2 class="help-title">不同插件，需要确认的地方</h2><div class="plugin-types"><div><h3>搜索、查询等工具</h3><p>确认工具已注册到目标会话，再按聊天授权和验证调用。</p></div><div><h3>长期记忆</h3><p>确认记忆归属，以及上下文召回、写入和删除状态处理。</p></div><div><h3>提醒、媒体与微信能力</h3><p>确认通知投递、附件展示和宿主接口；通常需要额外适配。</p></div></div>${faq('第一次连接：桥接配置具体怎么准备？',`<p>这是电脑端的首次手动配置。下列是路径示意，需替换成自己的实际安装位置；不会由本指南执行。</p><ul><li>为桥接准备新的专用目录，例如 C:/fish-with-me/private/bridge 和 private/workspace，不复用原微信聊天目录。</li><li>准备私有随机令牌文件，内容至少 32 字符。DSH 桥接与客户端读取同一个文件；不要发送给他人。</li><li>在 DSH 用户补丁中添加以下插件条目，llmModule、compactionModule 指向本机实际 DSH 模块。</li></ul><pre>- insert:
    - id: chatagent-bridge
      name: file:///C:/fish-with-me/packages/dsh-bridge/index.mjs
      config:
        root: C:/fish-with-me/private/bridge
        cwd: C:/fish-with-me/private/workspace
        tokenFile: C:/fish-with-me/private/bridge-token.txt
        port: 37827
        agentPreset: standard
        timeZone: Asia/Shanghai
        llmModule: file:///C:/DSH/node_modules/@deepseek-ai/dsh-llm/lib/index.js
        compactionModule: file:///C:/DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js</pre><p>复制项目 bridge.example.json 为私有配置，填写客户端目录、桥接地址和同一令牌文件：</p><pre>{
  "dataRoot": "C:/fish-with-me/private/client",
  "port": 37824,
  "bridgeUrl": "http://127.0.0.1:37827",
  "tokenFile": "C:/fish-with-me/private/bridge-token.txt"
}</pre><p>先按 DSH 当前版本的方式加载桥接，再从项目根目录运行客户端入口：</p><pre>node scripts/start-bridge.mjs C:/fish-with-me/private/client-bridge.json</pre><p>此命令中的 client-bridge.json 是上一步另存的私有配置。已有实例时先核对其配置和端口，不要重复启动。首次连接的开发说明见项目 docs/DSH-BRIDGE.md。</p>`)}${faq('DSH 已装插件，为什么这里看不到？','<p>先取消「仅看已启用」并刷新。再检查插件是否加载成功、工具是否对目标会话注册、宿主服务是否齐全。只提供后台钩子的插件未必有可勾选的工具；来源尚未确认的工具也可能暂不展示。</p>')}${faq('依赖微信发送或主动通知的插件怎么办？','<p>微信收发接口不能直接当作 fish with me 的收发接口。适配器需要把通知交给 chatagentBridge.publish，并传入目标 sessionId 和稳定、唯一的 deliveryId；图片、语音还需要附件映射。完成接入和实际验证前，不应标记为可用。</p>')}<div class="lesson-footer"><p>读到这里，就知道插件该在哪里安装和授权了。</p><div class="footer-buttons">${button('返回首页','welcome')}${button('了解手机连接','phone',true)}</div></div>`;}

function phone(){return heading('04 / 陪伴也可以随身','在手机上继续聊天','迁移和插件配置在电脑完成。手机连接同一个私人空间，就能继续日常聊天。')+`<div class="guide-layout"><section class="paper"><ol class="steps">${step(1,'确认电脑的设备入口可用','<p>保持电脑端聊天服务运行，进入「设置 → 设备」。确认设备入口已启用，记下页面显示的私人设备地址。</p><p>手机需要能访问这一私人网络。电脑页面若提示「远程连接尚未启用」，先配置设备入口，再继续配对。</p>')}${step(2,'安装手机应用，输入配对凭据','<p>打开电脑「设备」页，点击「生成配对凭据」。在 Android 应用的连接页面填写电脑提供的设备地址和一次性凭据，完成连接。</p><p>凭据有效期为 5 分钟，一份只登记一台设备；过期或取消后，需要重新生成。</p>','电脑设备列表中出现这台手机。')}${step(3,'打开聊天，确认同步','<p>在手机打开相应聊天，核对名称与记录，再发送一条普通消息，确认电脑保存、手机收到回复。</p><p>手机不需要安装 DSH 插件。模型和插件仍运行在电脑端；电脑或 DSH 离线时无法获得新的模型回复。</p>','手机可查看聊天，并收到实际回复。')}</ol></section><aside class="help-rail">${rail('旧手机包怎么升级？','<p>使用同包名、同签名的新版安装包覆盖升级，保留已有应用数据。不要为了换显示名先卸载旧应用。</p>',true)}${rail('配对凭据别公开','<p>只交给你自己的设备。设备丢失或不再使用时，可在电脑「设备」页撤销访问。</p>')}</aside></div>`+end('需要时再连接手机，现在也可以只用电脑。','welcome','later','先了解到这里');}

function later(){return `<section class="done"><img src="../../apps/branding/app-icon.png" alt="女孩与小鲸鱼"><h1 id="page-title" tabindex="-1">先到这里，也很好。</h1><p>不用一次准备完所有事情。<br>需要迁移资料、添加能力或连接手机时，<br>再回来看看对应的步骤就好。</p>${button('重新浏览指南','welcome',true)}<div class="done-links"><a href="#migration/astrbot">AstrBot 迁移</a><a href="#migration/wechatagent">WeChatAgent 迁移</a><a href="#plugins">DSH 插件接入</a></div></section>`;}

const referenceViews={start,'migration/astrbot':()=>migration('astrbot'),'migration/wechatagent':()=>migration('wechatagent'),plugins,voice:voiceReference,singing:singingReference,phone:()=>'<p class="note"><strong>当前手机连接方案需要手机和电脑都安装并连接 Tailscale。</strong>只用电脑不需要；普通同一 Wi‑Fi 直连目前尚未支持。</p>'+phone()};
const mockButton=(text,focus=false)=>`<span class="mock-button${focus?' point-here':''}">${text}</span>`;
const mockRow=(text,focus=false)=>`<div class="mock-row${focus?' point-here':''}">${text}</div>`;
const mockNav=(selected='聊天')=>`<div class="mock-sidebar"><span class="mock-brand">fish with me</span>${['聊天','插件','设置'].map(label=>`<div class="mock-nav${label===selected?' marked':''}">${label}</div>`).join('')}</div>`;
const importFields=(focus,source)=>`${mockRow('文件来自哪里',false)}${mockRow(source==='wechat'?'fish with me 资料包 / 转换后的 JSON ▾':'AstrBot 控制台导出（JSONL） ▾',focus==='format')}${mockRow('选择文件',focus==='file')}${source==='wechat'?'':mockRow('选择要导入的对话 ▾',focus==='conversation')}<div class="mock-actions">${mockButton('检查导入内容',focus==='check')}${mockButton('确认导入',focus==='apply')}</div>`;
function illustration(type,flowName){
  let app='fish with me',body='',description='';
  if(type==='desktop'){app='电脑桌面';body=`<div class="mock-desktop"><span class="mock-app point-here">${icon('chat')}<b>DSH</b></span><span class="mock-app"><img src="../../apps/branding/app-icon.png" alt=""><b>fish with me</b></span></div>`;description='电脑桌面上的 DSH 图标已用蓝框标出';}
  else if(type==='dsh'){app='DSH';body=`<div class="mock-sidebar"><span class="mock-brand">工作区</span><div class="mock-nav marked">fish with me</div></div><div class="mock-content"><h3>对应的聊天会话</h3>${mockRow('打开这段聊天',true)}<p class="mock-muted">模型：你已配置的聊天模型</p></div>`;description='在 DSH 打开 fish with me 对应的聊天会话';}
  else if(type==='dsh-plugins'){app='DSH';body=`<div class="mock-sidebar"><span class="mock-brand">DSH</span><div class="mock-nav">聊天</div><div class="mock-nav marked point-here">插件管理</div></div><div class="mock-content"><h3>插件</h3>${mockRow('想使用的插件')}${mockButton('按插件说明安装')}</div>`;description='先在 DSH 的插件管理安装要使用的插件，实际入口随版本变化';}
  else if(type==='astr-list'||type==='astr-select'||type==='astr-export'){app='AstrBot 控制台';body=`<div class="mock-sidebar"><span class="mock-brand">AstrBot</span><div class="mock-nav${type==='astr-list'?' point-here':''}">对话管理</div><div class="mock-nav">插件管理</div></div><div class="mock-content"><div class="mock-title"><h3>对话管理</h3>${mockButton('导出',type==='astr-export')}</div>${mockRow((type==='astr-select'?'☑':'□')+' 你想搬来的那段对话',type==='astr-select')}${mockRow('□ 其他对话')}<p class="mock-muted">下载后的文件以 .jsonl 结尾</p></div>`;description=type==='astr-list'?'AstrBot 对话管理的位置示意':type==='astr-select'?'在要导出的对话旁勾选方框':'AstrBot 对话列表上方的导出按钮已标出';}
  else if(type==='fish-chat'||type==='enter-chat'||type==='chat-settings'){body=`${mockNav('聊天')}<div class="mock-content"><div class="mock-title"><h3>聊天</h3>${mockButton('添加聊天')}</div>${mockRow('选择你要使用的聊天',type==='fish-chat')}<div class="mock-actions">${mockButton('设置此聊天',type==='chat-settings')}${mockButton('进入聊天',type==='enter-chat')}</div></div>`;description=type==='fish-chat'?'先点左侧聊天，再选择要使用的聊天':type==='enter-chat'?'聊天详情中的进入聊天按钮已用蓝框标出':'聊天详情中的设置此聊天按钮已用蓝框标出';}
  else if(type==='send'){body=`<div class="mock-chat"><span class="mock-chat-name">你选的聊天</span><span class="mock-bubble">收到回复后，就可以继续聊了。</span><div class="mock-composer"><span>你好</span>${mockButton('发送',true)}</div></div>`;description='在聊天输入框输入你好，再点击发送';}
  else if(type==='file'){app='刚刚下载的文件';body='<div class="mock-file point-here"><span class="file-symbol">JSONL</span><span>astrbot_conversations_export_…<b>.jsonl</b><small>记住文件保存的位置就好</small></span></div>';description='要选择从 AstrBot 下载的 jsonl 文件';}
  else if(type==='import-page'||['format','file-picker','conversation','check','apply'].includes(type)){const focus={format:'format','file-picker':'file',conversation:'conversation',check:'check',apply:'apply'}[type];body=`${mockNav('设置')}<div class="mock-content"><div class="mock-tabs"><span>外观</span><span class="${type==='import-page'?'point-here':''}">导入与备份</span></div><h3>导入其他聊天资料</h3>${importFields(focus,flowName)}</div>`;description='设置中的导入与备份页面，当前要点击的位置用蓝框标出';}
  else if(type==='portable'){body=`${mockNav('设置')}<div class="mock-content"><h3>导入其他聊天资料</h3>${mockRow('fish with me 资料包 / 转换后的 JSON',true)}${mockRow('选择文件')}<div class="mock-actions">${mockButton('检查导入内容')}${mockButton('确认导入')}</div></div>`;description='导入来源选择 fish with me 资料包或转换后的 JSON';}
  else if(['tools','filter','refresh','enable','save'].includes(type)){body=`<div class="mock-tools"><h3>设置此聊天</h3><div class="mock-tabs"><span>基本设置</span><span class="${type==='tools'?'point-here':''}">能力与权限</span></div><div class="mock-tools-filter"><span class="${type==='filter'?'point-here':''}">□ 仅看已启用</span>${mockButton('刷新',type==='refresh')}</div>${mockRow('☑ 想使用的插件工具',type==='enable')}<div class="mock-actions">${mockButton('保存此会话',type==='save')}</div></div>`;description='设置此聊天的能力与权限页面，当前操作位置用蓝框标出';}
  else if(type==='devices'||type==='credential'){body=`${mockNav('设置')}<div class="mock-content"><div class="mock-tabs"><span>导入与备份</span><span class="${type==='devices'?'point-here':''}">设备</span></div><h3>添加设备</h3>${mockButton('生成配对凭据',type==='credential')}<p class="mock-muted">凭据有效期 5 分钟</p></div>`;description='设置中的设备页面，可以生成一次性配对凭据';}
  else if(type==='phone'){app='手机连接页面';body='<div class="mock-phone"><h3>连接电脑</h3><div class="mock-row">电脑提供的设备地址</div><div class="mock-row">刚生成的一次性配对凭据</div><span class="mock-button point-here">完成配对</span></div>';description='在手机连接页面填写电脑显示的地址与一次性凭据';}
  else if(type==='voice-settings'||type==='voice-enable'){body=`${mockNav('设置')}<div class="mock-content"><div class="mock-tabs"><span>模型与连接</span><span class="${type==='voice-settings'?'point-here':''}">语音</span></div><h3>你说，她也说。</h3>${mockButton('一键配置语音',type==='voice-enable')}<p class="mock-muted">转文字 + 免费语音回复，一起准备好</p></div>`;description='设置中的语音页面，一键配置转文字和免费语音回复';}
  else if(type==='voice-ready'){body=`${mockNav('设置')}<div class="mock-content"><h3>准备好了</h3>${mockRow('✓ 你发语音，她根据文字理解')}${mockRow('✓ 她也能用免费声音回复')}${mockButton('试听一句')}<p class="mock-muted">首次下载约 300 MB，之后电脑本地处理</p></div>`;description='等待转文字和免费语音回复都准备好，显示准备好了后再试用';}
  else if(type==='voice-try'){app='手机聊天 · 操作示意';body=`<div class="mock-chat"><span class="mock-chat-name">你选的聊天</span><span class="mock-bubble">说一句：用语音回复我。</span><p class="mock-muted">按住录音，松开发送</p><div class="mock-composer">${mockButton('按住说话',true)}</div><p class="mock-muted">她回了语音后，点播放就能听到。</p></div>`;description='在手机按住说话发送语音请求，收到她的语音回复后点播放';}
  else if(type==='gpu-model'){app='Windows 任务管理器 · 位置示意';body=`<div class="mock-sidebar"><div class="mock-nav">进程</div><div class="mock-nav marked point-here">性能</div></div><div class="mock-content"><h3>GPU</h3>${mockRow('AMD → A 卡')}${mockRow('NVIDIA → N 卡')}<p class="mock-muted">记下完整型号，不只看 GPU 0 / GPU 1。</p></div>`;description='任务管理器性能页可以查看 GPU 显卡的完整型号';}
  else if(type==='gpu-engine'){app='电脑端 AI 语音 · 准备示意';body=`<div class="mock-content"><h3>先测试，再接入</h3>${mockRow('匹配显卡的语音引擎',true)}${mockRow('生成一句短语音')}${mockRow('确认播放正常')}<p class="mock-muted">安装引擎不等于聊天已经接通。</p></div>`;description='先在独立的 AI 语音引擎中测试显卡生成，再接入聊天';}
  else if(type==='singing-model'){app='电脑文件夹 · 准备示意';body='<div class="mock-file point-here"><span class="file-symbol">RVC</span><span>唱歌音色.pth<small>有配套的 .index 文件时一起保留</small></span></div>';description='唱歌使用匹配引擎的 RVC 音色模型，可带配套索引文件';}
  else if(type==='singing-config'){app='电脑端唱歌服务 · 配置示意';body=`<div class="mock-content"><h3>唱歌单独配置</h3>${mockRow('音色模型 → 新的 RVC 模型',true)}${mockRow('显卡环境 → 与本机匹配')}${mockRow('试唱一小段，再连接聊天')}<p class="mock-muted">当前仍需电脑端手动适配。</p></div>`;description='唱歌音色和显卡运行环境需在独立电脑端服务配置，不是应用中的现成开关';}
  else if(type==='singing-send'){body='<div class="mock-chat"><span class="mock-chat-name">已接通唱歌的聊天</span><span class="mock-bubble">请用新音色试唱一小段。</span><div class="mock-composer"><span>先确认选曲，再试一小段</span><span class="mock-button point-here">发送</span></div></div>';description='唱歌接入后，确认选曲并请求试唱短段，播放检查音色';}
  else if(type==='voice-file'){app='电脑文件夹 · 准备示意';body='<div class="mock-file point-here"><span class="file-symbol">WAV</span><span>新声音.wav<small>清楚、单人说话，尽量没有背景音乐</small></span></div>';description='准备一份有使用授权的参考录音 WAV 文件';}
  else if(type==='voice-text'){app='记事本 · 准备示意';body=`<div class="mock-content"><h3>录音里实际说了什么？</h3>${mockRow('把录音里说的话，原样写下来。',true)}<p class="mock-muted">这段文字要和录音一致，供电脑匹配声音。</p></div>`;description='把参考录音中的原话写下来，与参考录音一起准备';}
  else if(type==='voice-config'){app='电脑端语音服务 · 配置示意';body=`<div class="mock-content"><h3>新音色副本</h3>${mockRow('参考录音 → 新声音.wav')}${mockRow('对应文字 → 录音里的原话')}${mockRow('重新生成完整校验清单',true)}<p class="mock-muted">当前需要手动配置。不是应用里的换音色按钮。</p></div>`;description='电脑端新音色配置需要参考录音、对应文字与完整安装校验';}
  else if(type==='voice-send'){body='<div class="mock-chat"><span class="mock-chat-name">你选的聊天</span><span class="mock-bubble">用语音说：你好，今天也一起聊天吧。</span><div class="mock-composer"><span>输入上面这句话</span><span class="mock-button point-here">发送</span></div></div>';description='在已启用发送语音回复的聊天中发出试听请求，再播放回复确认音色';}
  const preparation=['voice-file','voice-text','voice-config','gpu-engine','singing-model','singing-config'].includes(type),waiting=type==='voice-ready';
  return `<figure class="where-to-click${preparation?' preparation-diagram':''}"><figcaption>看这里 <span>${preparation?'准备示意，请在电脑上操作':'位置示意，请在软件中操作'}</span></figcaption><div class="mock-window" role="img" aria-label="${description}"><div aria-hidden="true"><div class="mock-bar"><i></i><i></i><i></i><span>${app}</span></div><div class="mock-body">${body}</div></div></div><p class="diagram-key"><span></span>${waiting?'看到「准备好了」，再继续下一步。':preparation?'蓝色框标出这一步要准备或核对的内容。':'蓝色框内，就是这一步要找的位置。'}</p></figure>`;
}

const tutorialFlows={
  start:{name:'先聊起来',back:'welcome',reference:'start',steps:[
    {title:'先打开电脑上的 DSH',instruction:'切到电脑桌面，双击 DSH 图标。已经打开的话，就不用再开。',demo:'desktop',next:'打开了，下一步',help:'没看到 DSH 图标？',answer:'如果电脑还没安装 DSH，或还没连接过 fish with me，先停在这里。目前首次安装和连接还需要手动配置，不能只点「下一步」完成。',blocked:true},
    {title:'打开 fish with me 对应的会话',instruction:'在 DSH 里找到这段聊天并打开，确认已经选好能用的模型。',demo:'dsh',next:'找到了，下一步',help:'列表里没有这段聊天？',answer:'旧版工作区可能仍叫「Chatagent」。如果两个名字都找不到，首次连接可能还没完成；请先完成连接，再继续。',blocked:true},
    {title:'回到 fish with me，点「聊天」',instruction:'在左边点「聊天」，再选你想进入的那段聊天。',demo:'fish-chat',next:'选好了，下一步',help:'里面一段聊天都没有？',answer:'点右上角「添加聊天」，填写名称、选择人格，再点「创建聊天」。没有可选人格时，需要先准备人格卡。'},
    {title:'点「进入聊天」',instruction:'选好聊天后，找到「进入聊天」，点一下。',demo:'enter-chat',next:'进去了，下一步',help:'没看到「进入聊天」？',answer:'先在聊天列表中选中一段聊天，右边才会显示它的详情和「进入聊天」。'},
    {title:'发一句「你好」',instruction:'在输入框写「你好」，点「发送」，等她回复。',demo:'send',next:'收到回复了',help:'一直没收到回复？',answer:'先看聊天里的连接提示。确认电脑上的 DSH 没关，前面那段会话也选好了模型。还没连接时，消息能保存，但不会有模型回复。'}
  ]},
  astrbot:{name:'搬来 AstrBot 的旧聊天',back:'migration/astrbot',reference:'migration/astrbot',steps:[
    {title:'打开 AstrBot 的「对话管理」',instruction:'先切到原来的 AstrBot 控制台，找到「对话管理」或「会话管理」。',demo:'astr-list',next:'找到了',help:'名称和图里不一样？',answer:'新版可能放在「数据与日志 → 会话」里面。找的是以前一段段对话的列表，不是运行日志。'},
    {title:'勾选你想搬来的那段聊天',instruction:'在那段聊天旁边的小方框里打勾。第一次先选一段就好。',demo:'astr-select',next:'勾好了',help:'不知道该选哪一段？',answer:'先打开会话预览，看看是不是你想保留的对话。确认后再导出，不用把所有账号和群聊一起搬。'},
    {title:'点「导出」',instruction:'把下载的文件保存好。文件名最后应该是 .jsonl，不用打开或修改。',demo:'astr-export',next:'文件下载好了',help:'找不到下载的文件？',answer:'打开浏览器的下载列表，找到刚下载的文件，再点「在文件夹中显示」。如果文件过大，可在 AstrBot 按会话分批导出。'},
    {title:'回到 fish with me，打开「导入与备份」',instruction:'在电脑端点「设置」，再点「导入与备份」。',demo:'import-page',next:'页面打开了',help:'我现在用的是手机？',answer:'这段资料迁移需要在电脑端做。手机不用重新安装 DSH，也不需要自己导入一份。'},
    {title:'选「AstrBot 控制台导出（JSONL）」',instruction:'找到「文件来自哪里」，把它改成图里这个选项。',demo:'format',next:'选好了',help:'还让我填一个来源名字？',answer:'填一个你自己认得出的名字就行，例如「我的 AstrBot」。它用来区分来源，不是账号或密码。'},
    {title:'选择刚才下载的文件',instruction:'点「选择文件」，找到刚从 AstrBot 下载的 .jsonl 文件并选中。',demo:'file-picker',next:'文件选好了',help:'提示文件太大或格式不对？',answer:'当前上限为 32 MiB。文件太大时回 AstrBot 分批导出；格式不对时重新用会话导出，不要手改文件后缀。'},
    {title:'选对你要搬的那段聊天',instruction:'在「选择要导入的对话」里，选择刚才那段聊天。',demo:'conversation',next:'对话选对了',help:'文件里只有一段对话？',answer:'核对默认选中的那段就行。一个文件有多段时，一次选其中一段导入。'},
    {title:'点「检查导入内容」',instruction:'先看检查结果。有冲突或不认识的内容，就停下来核对。',demo:'check',next:'检查过了，没有冲突',help:'出现「冲突」或「缺失附件」？',answer:'有冲突时先别确认导入，核对原件后重新检查。缺失附件表示图片或语音原文件没带来；聊天文字和附件需要分别核对。'},
    {title:'点「确认导入」',instruction:'确认检查结果无误后再点。完成后，回聊天里看看旧记录在不在。',demo:'apply',next:'我已核对旧记录',help:'聊天搬来了，她却没记住以前的事？',answer:'这些步骤搬的是聊天原文。插件保存的长期记忆需要另外迁移，不能因为聊天导入了，就认为记忆也已经启用。',extra:'<a href="#memory/astrbot">我还想搬长期记忆 →</a>'}
  ]},
  wechat:{name:'导入已经转换好的 WeChatAgent 资料',back:'migration/wechatagent',reference:'migration/wechatagent',steps:[
    {title:'先确认你拿到的是转换好的 JSON',instruction:'需要的是给 fish with me 使用的资料包，不是 WeChatAgent 文件夹或原数据库。',demo:'portable',next:'我有转换好的资料包',help:'我只有原来的 WeChatAgent？',answer:'目前还需要按来源版本采集、转换，不能直接选原目录导入。你不用手改 JSON，先查看需要准备的资料。',extra:'<a href="#wechat-help">看看要准备什么 →</a>'},
    {title:'打开「设置 → 导入与备份」',instruction:'在电脑端打开 fish with me 的「设置」，再点「导入与备份」。',demo:'import-page',next:'页面打开了',help:'找不到这个页面？',answer:'这一步要在电脑端进行。它在设置中，不在聊天的文件发送按钮里。'},
    {title:'选择「资料包 / 转换后的 JSON」',instruction:'在「文件来自哪里」选择图里这个选项，再选转换好的 JSON 文件。',demo:'portable',next:'资料包选好了',help:'能不能直接选备份文件夹？',answer:'不能。原始采集目录、ZIP 和原数据库不是这里可直接导入的 JSON 资料包，需要先转换。'},
    {title:'点「检查导入内容」',instruction:'核对记录数量和冲突情况，确认是你想搬来的那段聊天。',demo:'check',next:'检查过了，没有冲突',help:'检查报错，怎么办？',answer:'先停在这里，保留原文件与检查提示，核对转换器是否匹配来源版本。不要为了通过检查自己删改记忆或来源信息。'},
    {title:'确认导入，再回聊天核对',instruction:'检查无误后点「确认导入」，然后看看旧聊天记录是否已经出现。',demo:'apply',next:'我已核对旧记录',help:'长期记忆也搬好了吗？',answer:'不一定。记忆需要另外写入对应会话的记忆库；目前已有鱼的记忆 1.5.0 原生条目适配，其他插件或版本需单独确认。',extra:'<a href="#memory/wechatagent">查看长期记忆该怎么处理 →</a>'}
  ]},
  plugins:{name:'让这段聊天使用插件',back:'welcome',reference:'plugins',steps:[
    {title:'先在 DSH 里装好插件',instruction:'打开 DSH 的插件管理，按插件说明完成安装、启用和参数填写。',demo:'dsh-plugins',next:'插件已经装好了',help:'我只拿到了一个插件配置 JSON？',answer:'配置文件不是插件程序。先确认对应插件已经在 DSH 安装并成功加载；每个插件的安装方法按作者说明操作。入口可能随 DSH 版本变化。'},
    {title:'回到 fish with me，点「设置此聊天」',instruction:'在「聊天」里选中要使用插件的那段聊天，再点「设置此聊天」。',demo:'chat-settings',next:'设置打开了',help:'为什么要选某一段聊天？',answer:'工具开关按聊天分别保存。给这一段开了，不会自动给其他聊天也开启。'},
    {title:'点「能力与权限」',instruction:'在弹出的设置窗口中，点上方的「能力与权限」。',demo:'tools',next:'找到了',help:'页面和图里不完全一样？',answer:'找「设置此聊天」里的能力与权限页。不要去「导入插件」上传安装包；那个入口只处理配置文件。'},
    {title:'去掉「仅看已启用」的勾',instruction:'这个勾去掉以后，还没启用的插件工具才会显示。',demo:'filter',next:'已经去掉了',help:'本来就没有打勾？',answer:'那就不用改，直接去下一步。'},
    {title:'点一下「刷新」',instruction:'重新读取当前会话能使用的插件工具。',demo:'refresh',next:'刷新好了',help:'刷新后还是没有我的插件？',answer:'先确认它在 DSH 加载成功，并且能用于这段会话。有些插件只有后台功能，不会出现可勾选的工具；依赖微信收发的插件还需要适配。'},
    {title:'找到插件，勾选想用的工具',instruction:'可以先搜索插件名。只勾选你希望这段聊天使用的功能。',demo:'enable',next:'勾选好了',help:'这是记忆插件，要注意什么？',answer:'还要确认它绑定当前聊天的记忆库。自动记忆的保存和召回不一定只靠工具开关；启用后需要实际验证。'},
    {title:'点「保存此会话」',instruction:'保存后，回到聊天里试一次对应功能，确认结果确实能用。',demo:'save',next:'保存了，我会回聊天验证',help:'存好配置，功能还是用不了？',answer:'检查 DSH 的权限和插件报错。需要本地模型、微信接口或通知投递的能力，还要完成对应接入；不是勾选后就自动兼容。'}
  ]},
  freevoice:{name:'一键配好基础语音',back:'voice',reference:'voice',steps:[
    {title:'点「一键配置语音」',instruction:'电脑上选好聊天，打开「设置 → 语音」，点「一键配置语音」。',demo:'voice-enable',next:'已经点了',help:'找不到这个按钮？',answer:'需要更新后的电脑端和 DSH 媒体组件。第一次还没连接过 DSH 时，先完成文字聊天。这里的示意图只教你找位置。'},
    {title:'等它显示「准备好了」',instruction:'首次自动下载约 300 MB。先别关电脑，显示「准备好了」再继续。',demo:'voice-ready',next:'显示准备好了',help:'需要自己装 Python、填接口或选显卡吗？',answer:'不用。转文字组件会自动下载并检查，已有可用转写会复用。下载失败就检查网络，再点一次重试。免费回复使用 Windows 中文声音；缺少时会提示添加。'},
    {title:'回聊天，试一下',instruction:'手机按住说话发一句「用语音回复我」。她会先理解文字，再回你一条语音，点播放就能听到。',demo:'voice-try',next:'我试过了',help:'电脑上怎么试？',answer:'电脑可以添加一段语音文件，或者直接打字说「用语音说：你好」。只想检查声音时，在语音设置页点「试听一句」。聊天语音还需要当前模型实际调用语音工具。'}
  ]},
  voice:{name:'定制她说话的声音',back:'voice/custom',reference:'voice',steps:[
    {title:'先准备一小段新声音',instruction:'把一段清楚的单人说话录音存到电脑上，使用 WAV 文件。先用自己的录音或允许使用的声音。',demo:'voice-file',next:'录音准备好了',help:'没有录音，能先试一下吗？',answer:'可以使用 CosyVoice 官方示例录音，参考录音和原话都在详细说明里。普通免费语音回复不需要准备这些文件。',extra:'<a href="#voice/agent/custom">不想手动配？复制给 Agent →</a> · <a href="#reference/voice">官方示例与详细说明 →</a>'},
    {title:'把录音里的话写下来',instruction:'听一遍这段录音，把里面说的话原样写进记事本，和录音一起保存。',demo:'voice-text',next:'文字也准备好了',help:'写的是我希望她以后说的话吗？',answer:'这里写的是参考录音本身的原话，用来匹配声音。她以后要说什么，仍然由聊天中的回复决定。'},
    {title:'在电脑端准备新的音色',instruction:'这一步可以交给 Agent。用新录音和对应文字生成新的语音副本，接到当前聊天后，在「设置 → 语音」恢复 AI 音色。',demo:'voice-config',next:'电脑端已经配置好了',help:'这一步具体怎么做？',answer:'复制下方提示词，让 Agent 检查文件并配置；也可以按详细说明手动准备。只替换旧目录中的音频会导致校验失败。',extra:'<a href="#voice/agent/custom">复制给 Agent，帮我配置 →</a> · <a href="#reference/voice">手动配置说明 →</a>'},
    {title:'让她说一句，听听看',instruction:'在聊天里发送图中的这句话。收到语音后点播放，确认确实换成了你准备的声音。',demo:'voice-send',next:'听到新声音了',help:'只回文字，或者还是原来的声音？',answer:'先到「设置此聊天 → 能力与权限」启用「发送语音回复」并保存。还只有文字时，检查电脑端服务；声音没变时，核对桥接使用的新语音目录是否正确，是否已经重新加载。',extra:'<a href="#plugins">查看插件与工具开关教学 →</a>'}
  ]},
  singing:{name:'定制她唱歌的声音',back:'voice/custom',reference:'singing',steps:[
    {title:'先准备唱歌的音色模型',instruction:'准备与唱歌引擎兼容的 RVC 模型（通常是 .pth）。如果带配套的 .index 文件，一起保存。',demo:'singing-model',next:'模型准备好了',help:'只有说话录音，可以直接用吗？',answer:'不可以直接当作 RVC 模型。可以选已经提供的、允许使用的唱歌音色模型；自己录音训练是另一件事，不放进基础教程。',extra:'<a href="#voice/agent/singing">准备好模型了？复制给 Agent →</a>'},
    {title:'在电脑端接入新的唱歌音色',instruction:'可以交给 Agent。把新音色放进独立唱歌环境，先试唱一小段。',demo:'singing-config',next:'电脑端试唱通过了',help:'应用里在哪里上传模型？',answer:'复制下方提示词，把模型文件夹路径发给 Agent，它会检查环境和模型是否兼容。有试唱素材时先试一小段；没有时需要之后选曲验证。',extra:'<a href="#voice/agent/singing">复制给 Agent，帮我配置 →</a> · <a href="#reference/singing">电脑端接入说明 →</a>'},
    {title:'开启当前聊天的「唱歌」工具',instruction:'打开「设置此聊天 → 能力与权限」，刷新后勾选唱歌工具，再点「保存此会话」。',demo:'enable',next:'唱歌工具已经保存',help:'找不到唱歌工具？',answer:'先确认电脑端唱歌服务已接入这段聊天。只配置说话音色不会出现唱歌功能。',extra:'<a href="#plugins">一步步找工具开关 →</a>'},
    {title:'先听一小段，确认声音',instruction:'在聊天中确认要唱的歌，再请她用新音色试唱一小段。播放核对后，再唱完整的。',demo:'singing-send',next:'我已核对唱歌音色',help:'还是原来的声音？',answer:'先停止新的试唱，核对独立唱歌环境使用的模型与校验。不要继续重复发送完整歌曲。'}
  ]},
  gpuamd:{name:'A 卡加快 AI 说话',back:'voice/amd',reference:'voice',steps:[
    {title:'先记下 A 卡的完整型号',instruction:'按 Ctrl + Shift + Esc 打开任务管理器，点「性能 → GPU」，记下 AMD 后面的完整型号。',demo:'gpu-model',next:'型号记下了',help:'只看到 Intel，或者不认识型号？',answer:'Intel 不是这里的 A 卡。先继续使用免费系统声音；确认显卡型号后再选匹配环境。'},
    {title:'先让匹配的 HIP 引擎说一句',instruction:'按官方 HIP 说明准备与显卡匹配的语音引擎，先生成一句短语音。',demo:'gpu-engine',next:'引擎已生成语音',help:'需要自己编译或遇到显存错误？',answer:'先保留可用的 CPU 方案。HIP 需要匹配显卡、驱动与引擎版本，当前没有覆盖所有 A 卡的一键安装器。',extra:official('打开官方 HIP 说明','https://github.com/0xShug0/audio.cpp/blob/main/docs/build/HIP.md')},
    {title:'接到当前聊天，再试听',instruction:'按电脑端说明生成新的 HIP 运行目录并接入。回聊天请求一条短语音，检查速度和播放。',demo:'voice-send',next:'实际语音已核对',help:'只把 cpu 改成 hip 行吗？',answer:'不够。当前语音目录带文件校验，改配置后需要重新生成完整校验；还要确认 HIP 引擎可运行。',extra:'<a href="#reference/voice">查看 HIP 接入与回退说明 →</a>'}
  ]},
  phone:{name:'在手机继续聊',back:'phone',reference:'phone',steps:[
    {title:'先在电脑点「设置 → 设备」',instruction:'保持电脑服务运行，确认设备页显示了手机能访问的设备地址。',demo:'devices',next:'看到了设备地址',help:'写着「远程连接尚未启用」？',answer:'先停在这里，设备入口还没有配置好。手机需要能访问电脑的私人网络，配对凭据本身不能代替网络连接。'},
    {title:'点「生成配对凭据」',instruction:'这份凭据只给你自己的手机用，5 分钟后过期。',demo:'credential',next:'凭据生成好了',help:'已经过期，或者刚刚取消过？',answer:'在电脑重新生成一份，使用新凭据。旧的不能再用。'},
    {title:'在手机填写地址和配对凭据',instruction:'打开手机应用的连接页面，填入电脑提供的设备地址和刚生成的凭据。',demo:'phone',next:'手机已经连接了',help:'需要在手机安装 DSH 吗？',answer:'不需要。DSH 和插件继续在电脑运行，手机只连接这一份私人空间。'},
    {title:'打开聊天，试着发一句「你好」',instruction:'先核对聊天名称，再发一条消息，确认手机收到了回复。',demo:'send',next:'手机收到回复了',help:'只能看到旧消息，收不到新回复？',answer:'确认电脑和 DSH 都在运行，再检查对应聊天的模型连接。手机配对完成不等于模型一定在线。'}
  ]}
};

function easyHome(){return `<section class="easy-welcome"><div><p class="eyebrow">第一次用？跟着点就好。</p><h1 id="page-title" tabindex="-1">先让她<br>回你一句话。</h1><p>不用先学懂设置。<br>一次做一步，找不到就点「没找到」。</p>${button('好，带我一步步来','start',true)}<a class="already-chatting" href="#complete">已经能聊天了，看看其他功能 →</a></div><img src="../../apps/branding/app-icon.png" alt="蓝发女孩与小鲸鱼"></section><div class="easy-shortcuts"><a href="#move">${icon('archive')}<span>我想搬旧资料</span>${icon('arrow')}</a><a href="#plugins">${icon('plugin')}<span>我想添加插件</span>${icon('arrow')}</a><a href="#voice">${icon('voice')}<span>我想让她开口说话</span>${icon('arrow')}</a><a href="#phone">${icon('phone')}<span>我想用手机聊</span>${icon('arrow')}</a></div>`;}

function easyChoice(title,description,cards,back='welcome'){return `<section class="easy-choice"><a class="easy-back" href="#${back}">← 返回</a><h1 id="page-title" tabindex="-1">${title}</h1><p>${description}</p><div class="easy-choice-cards">${cards.map(([label,note,target])=>`<a href="#${target}"><strong>${label}</strong><span>${note}</span>${icon('arrow')}</a>`).join('')}</div></section>`;}
function sourceChoice(source){return easyChoice('你想搬哪种资料？',source==='astrbot'?'从 AstrBot 搬来。先分清这两样就好。':'从 WeChatAgent 搬来。先看看你手里有什么。',source==='astrbot'?[
  ['以前的聊天记录','就是你们一条一条说过的话。','walk/astrbot/0'],
  ['长期记忆','插件记下的喜好、经历和重要事情。','memory/astrbot']
]:[
  ['我只有原来的 WeChatAgent','目前不能直接选原目录导入，先看准备说明。','wechat-help'],
  ['我已经有转换好的 JSON 资料包','直接跟着步骤导入。','walk/wechat/0'],
  ['我想搬长期记忆','先确认使用的是哪一个记忆插件。','memory/wechatagent']
],'move');}

function wizard(flowName,index){
  const flow=tutorialFlows[flowName],item=flow.steps[index],target=index===flow.steps.length-1?(['freevoice','voice','singing','gpuamd'].includes(flowName)?'voice':'complete'):`walk/${flowName}/${index+1}`;
  const back=index?`walk/${flowName}/${index-1}`:flow.back;
  return `<div class="walk-top"><a href="#${back}" class="easy-back">← ${index?'上一步':'返回'}</a><span>${flow.name}</span><span>第 ${index+1} / ${flow.steps.length} 步</span></div><progress class="walk-progress" value="${index+1}" max="${flow.steps.length}" aria-label="教程进度"></progress><section class="walk-card"><div class="walk-copy"><span class="do-one-thing">现在只做这一件事</span><h1 id="page-title" tabindex="-1">${item.title}</h1><p class="walk-instruction">${item.instruction}</p><details class="walk-help"><summary>${item.help||'没找到／卡住了？'}</summary><p>${item.answer}</p>${item.blocked?'<p class="setup-gap">这一步需要先完成首次连接，目前还没有一键设置。</p>':''}<a href="#reference/${flow.reference}">确实需要手动设置？查看详细说明 →</a></details>${item.extra?`<p class="walk-extra">${item.extra}</p>`:''}</div>${illustration(item.demo,flowName)}</section><div class="walk-bottom"><p>在软件里完成这一步，再继续。<br><small>示意图里的按钮不能直接操作你的软件。</small></p>${button(item.next,target,true)}</div>`;
}

function memoryHelp(source){return `<section class="easy-choice"><a href="#migration/${source}" class="easy-back">← 返回</a><span class="plain-badge">这部分还不能一键完成</span><h1 id="page-title" tabindex="-1">先看看，用的是哪种记忆。</h1><p>聊天文件搬过来了，不等于她的长期记忆也搬好了。</p><div class="plain-explanation"><h2>你现在只需要做一件事</h2><p>去原来的插件列表，记下<strong>记忆插件的名字和版本</strong>。</p><p>有「导出记忆」就按插件说明导出；没有的话，先保留原来的资料。</p><hr><p>目前已有<strong>鱼的记忆 1.5.0</strong>迁移工具，但仍需在电脑配置。其他插件或版本需要单独适配。</p></div><div class="plain-actions">${button('先看怎么搬聊天',`migration/${source}`,true)}<a href="#reference/migration/${source}">查看完整说明</a></div></section>`;}
function wechatHelp(){return `<section class="easy-choice"><a href="#migration/wechatagent" class="easy-back">← 返回</a><span class="plain-badge">目前需要先转换</span><h1 id="page-title" tabindex="-1">这一步，先不用乱点。</h1><p>现在还不能把 WeChatAgent 文件夹直接搬进来。</p><div class="plain-explanation"><h2>先记下这三样</h2><ol><li>WeChatAgent 的版本。</li><li>你想搬哪一段聊天。</li><li>记忆插件的名字和版本。</li></ol><p>原资料先留好。接下来需要按这个版本采集、转换，得到可导入的 JSON 资料包；目前这一步还没有通用的一键工具。</p><p><strong>不用自己写代码，也不要手改文件。</strong></p></div><div class="plain-actions">${button('我已经有转换好的资料包','walk/wechat/0',true)}<a href="#reference/migration/wechatagent">给负责转换的人看详细说明 →</a></div></section>`;}
function easyComplete(){return easyChoice('其他的，想用时再学。','你可以挑一个现在需要的功能，继续跟着点。',[
  ['搬来旧聊天与记忆','先选来源，再一步步来。','move'],
  ['让聊天使用插件','安装、显示出来、勾选、保存。','plugins'],
  ['语音与唱歌','免费语音一键开，显卡和定制声音放进阶。','voice'],
  ['连接自己的手机','在电脑生成凭据，再到手机填写。','phone']
]);}

function phonePrerequisite(){return easyChoice('两边的 Tailscale 都连上了吗？','当前手机方案需要电脑、手机都安装并连接 Tailscale。同一 Wi‑Fi 暂时也需要。',[
  ['都连上了','继续到电脑生成配对凭据。','walk/phone/0'],
  ['还没有','先看看要准备什么。','phone-network']
]);}
function phoneNetworkHelp(){return `<section class="easy-choice"><a href="#phone" class="easy-back">← 返回</a><h1 id="page-title" tabindex="-1">先把手机和电脑连起来。</h1><p>Tailscale 帮手机找到电脑。我们目前的手机连接方案使用它。</p><div class="plain-explanation"><h2>需要准备这三件事</h2><ol><li>电脑和手机都安装 Tailscale。</li><li>两边用同一个 Tailscale 账号登录。</li><li>确认两边都显示已经连接。</li></ol><p>然后再回到这里，生成 fish with me 的配对凭据。</p><p><strong>只用电脑可以不装。</strong>手机和电脑通过普通同一 Wi‑Fi 直接连接，目前还没有这个模式。</p></div><div class="plain-actions"><a class="primary" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">去官网下载 Tailscale ↗</a>${button('我已经连接好两边','walk/phone/0')}<a href="https://tailscale.com/docs/how-to/quickstart" target="_blank" rel="noopener noreferrer">官方连接步骤 ↗</a></div></section>`;}

function voiceHome(){return easyChoice('点一次，语音就配好了。','你发语音，她能理解；她也能用免费声音回复。',[
  ['开始一键配置语音','跟着三步做，不用填接口、不用选显卡。','walk/freevoice/0']
])+'<div class="voice-secondary"><p>首次自动下载约 300 MB，之后在电脑本地转文字、生成语音。基础声音偏朗读风格。</p><p><a href="#voice/agent">想交给 DSH / Codex 配置？复制提示词 →</a></p>'+faq('进阶：定制音色、唱歌、显卡加速','<p><a href="#walk/voice/0">换说话音色 →</a></p><p><a href="#walk/singing/0">唱歌与唱歌音色 →</a></p><p><a href="#voice/advanced">A 卡 / N 卡加速 →</a></p>')+'<p><a href="#voice/hearing">她怎么理解我发的语音？ →</a></p></div>';}

function agentSpeechChoice(){return easyChoice('准备文件，剩下交给 Agent。','选一项，复制提示词，连同素材文件夹路径发给电脑端 DSH / Codex。',[
  ['基础语音','不需要文件：自动转文字 + 免费语音回复。','voice/agent/basic'],
  ['定制说话音色','准备 WAV；录音原话有就一起放。','voice/agent/custom'],
  ['定制唱歌音色','准备 RVC 模型，配套索引有就一起放。','voice/agent/singing'],
  ['显卡加速（进阶）','先配好说话或唱歌，Agent 帮你检查显卡。','voice/agent/gpu']
],'voice');}

function agentSpeech(kind){
  const task=speechAgentTasks[kind],materials=['custom','singing'].includes(kind);
  return `<section class="easy-choice agent-speech"><a class="easy-back" href="#voice/agent">← 换一种功能</a><span class="plain-badge">交给 DSH / Codex 配置</span><h1 id="page-title" tabindex="-1">${task.title}</h1><p>${task.note}</p><div class="plain-explanation agent-materials"><h2>你只需要准备</h2><ul>${task.files.map(file=>`<li>${file}</li>`).join('')}</ul><p>${materials?'放进同一个文件夹，例如 <code>D:/MyVoice</code>。文件名可以不同，Agent 会先检查。':'告诉 Agent 要配置哪一段聊天，它会自己检查现有环境。'}</p></div><ol class="agent-instructions"><li>在电脑端 Agent 打开本项目。</li><li>复制下面的提示词，${materials?'和素材文件夹路径一起发给它':'告诉它要配置的聊天'}。</li><li>等它完成配置，${kind==='basic'?'发语音试试':'打开试听文件，确认声音'}。</li></ol><div class="agent-copy"><button class="primary" data-copy-speech="${kind}">复制</button><p id="agent-copy-status" role="status" aria-live="polite"></p></div><details class="faq agent-prompt-details"><summary>查看提示词内容</summary><label class="agent-prompt-label" for="agent-prompt">可以直接复制下面的完整文字</label><textarea id="agent-prompt" readonly spellcheck="false"></textarea></details><p class="agent-note">${task.outcome} 需要能读写本地文件、执行命令的 Agent；复制后还需粘贴发送。缺少兼容引擎时，它会说明还差什么。</p><p><a href="#${kind==='singing'?'walk/singing/0':kind==='custom'?'walk/voice/0':kind==='gpu'?'voice/advanced':'walk/freevoice/0'}">我想自己跟着图操作 →</a></p></section>`;
}

function voiceFree(){return `<section class="easy-choice"><a href="#voice" class="easy-back">← 返回</a><h1 id="page-title" tabindex="-1">三步，配好基础语音。</h1><p>转文字和免费回复，一起配置。</p><div class="plain-explanation"><ol><li>电脑打开「设置 → 语音」，点「一键配置语音」。</li><li>等「准备好了」。首次联网下载约 300 MB。</li><li>发一条语音试试，再让她「用语音回复我」。</li></ol><p>不用装 Python、不用填接口。定制音色、唱歌和显卡加速留到进阶。</p></div><div class="plain-actions">${button('带我一步步点','walk/freevoice/0',true)}</div></section>`;}

function voiceHearing(){return `<section class="easy-choice"><a href="#voice" class="easy-back">← 返回</a><h1 id="page-title" tabindex="-1">你说话，她看转写文字。</h1><p>先一键配置，以后发语音就自动转文字。</p><div class="plain-explanation"><h2>你说「今天好累」</h2><p>电脑转成「今天好累」这几个字。</p><p>她读到文字，再回复你。</p><p>这条基础流程只把文字交给聊天模型。转文字在电脑上完成，不用另买音频接口。</p></div>${faq('那「听原音」是什么？','<p>是另一项可选功能：把录音直接交给支持音频的模型，需要另配接口和工具。基础语音可以先不用它。</p>')}<div class="plain-actions">${button('开始一键配置','walk/freevoice/0',true)}</div></section>`;}

function voiceAdvanced(){return easyChoice('进阶：先看看是什么显卡。','按 Ctrl + Shift + Esc → 性能 → GPU，看右上角的名字。免费系统声音不用设置显卡。',[
  ['写着 AMD · 这是 A 卡','继续选择：加快说话，还是唱歌。','voice/amd'],
  ['写着 NVIDIA · 这是 N 卡','先看当前支持情况，再准备对应环境。','voice/nvidia']
],'voice')+'<div class="voice-secondary"><p>只看到 Intel 或不确定？先继续用免费声音，普通聊天不受影响。</p></div>';}

function voiceGpu(kind){const amd=kind==='amd';return easyChoice(amd?'A 卡：你想加快哪一种？':'N 卡：先看支持到哪一步。',amd?'说话和唱歌用不同引擎，分开配置。':'当前应用的 AI 说话尚未接通 CUDA；唱歌也需要单独适配环境。',[
  ['AI 说话',amd?'HIP 引擎 → 测一句 → 接到聊天。':'目前继续用免费声音或已有 CPU 语音。',amd?'walk/gpuamd/0':'voice/nvidia-status'],
  ['唱歌',amd?'当前唱歌方案含 DirectML 加速，需要匹配本机。':'当前没有通用 CUDA 唱歌安装入口。','voice/singing-gpu/'+kind]
],'voice/advanced');}

function voiceCustom(){return easyChoice('进阶：你想换哪种声音？','这两种分开准备。当前定制音色仍需电脑端配置。',[
  ['她说话的声音','准备录音和原话 → 电脑配置 → 听一句。','walk/voice/0'],
  ['她唱歌的声音','准备 RVC 音色模型 → 接入 → 试唱一小段。','walk/singing/0']
],'voice');}

function nvidiaStatus(){return `<section class="easy-choice"><a class="easy-back" href="#voice/nvidia">← 返回</a><span class="plain-badge">CUDA 接入尚未完成</span><h1 id="page-title" tabindex="-1">N 卡说话加速，先不用改配置。</h1><p>上游语音引擎有 CUDA 方案，当前应用适配器还没有接通。</p><div class="plain-explanation"><h2>现在先这样用</h2><p>用免费系统声音，或保留现有 CPU 的 AI 音色。</p><p>不能只把配置里的 cpu 改成 cuda；这会无法通过当前应用的检查。</p></div><div class="plain-actions">${button('返回免费语音教程','voice/free',true)}${official('查看上游 CUDA 环境要求','https://github.com/0xShug0/audio.cpp/blob/main/docs/build/windows.md')}</div></section>`;}

function singingGpu(kind){const amd=kind==='amd';return `<section class="easy-choice"><a class="easy-back" href="#voice/${kind}">← 返回</a><span class="plain-badge">唱歌 · 当前需电脑端适配</span><h1 id="page-title" tabindex="-1">${amd?'A 卡唱歌，走独立加速环境。':'N 卡唱歌，还没有一键安装入口。'}</h1><p>开了说话加速，不代表唱歌也配置好了。</p><div class="plain-explanation"><h2>只记住这三件事</h2><ol><li>记下显卡的完整型号。</li><li>${amd?'在独立唱歌环境中确认 DirectML 能识别这张卡。':'先为这张卡适配唱歌引擎；当前封存环境不是通用 CUDA 安装包。'}</li><li>试唱一小段，确认可播放和生成速度，再连接聊天。</li></ol><p>${amd?'现有唱歌环境含 DirectML 加速，但不保证每张 A 卡都能直接使用。':'当前应用没有 N 卡唱歌开关，不能照 A 卡教程安装后就当作已支持。'}</p></div><div class="plain-actions">${button('看看定制唱歌声音','walk/singing/0',true)}<a href="#reference/singing">电脑端目前支持情况 →</a></div></section>`;}

function singingReference(){return heading('进阶 / 唱歌电脑端说明','唱歌使用单独的音色模型和环境','目前沿用已配置的 RVC 唱歌流水线，还没有面向任意电脑的一键安装和换音色界面。')+`<section class="paper voice-reference"><h2>先准备什么？</h2><p>准备允许使用、与当前 RVC 引擎版本兼容的音色模型，通常是 .pth，以及该模型配套的 .index（如有）。参考录音 WAV 用于说话；唱歌模型不是把录音改个后缀得到的。</p><h2>电脑端要完成哪些接入？</h2><ol><li>保留现有唱歌环境。先在新的独立环境加载新模型，核对版本、采样率与配套索引。</li><li>在该环境试唱短段，检查分离、变声和混音的完整结果；单独变声成功不等于整条唱歌流程已可用。</li><li>按实际 worker 的配置更新模型和路径，重新生成该环境的完整校验与 runtimePins，再让当前聊天的 singingFile 指向对应配置。当前没有适用于所有 worker 的通用配置片段。</li><li>重新加载对应桥接后，到「设置此聊天 → 能力与权限」刷新，勾选「唱歌」工具并保存。确认选曲后请求短段，播放核对新音色和投递结果。</li></ol><h2>A 卡和 N 卡</h2><p>项目已有的独立唱歌准备脚本复制的是现成环境：包含 CPU、DirectML、分离与混音组件，需要先有匹配的源安装。它不是通用下载安装器，也不能只将 device 改为 cuda 来迁移到 N 卡。</p><p>为其他显卡接入新的运行环境后，必须核对驱动、引擎、模型和整段输出。当前没有应用内显卡选择和唱歌音色上传入口。</p><h2>没有这些环境怎么办？</h2><p>先停在「准备音色模型」这一步。免费语音回复仍然可以用。后续需要把独立唱歌环境配置好，再继续工具开关和试唱步骤。</p><p>${button('回到逐步教程','walk/singing/0',true)}${button('显卡支持情况','voice/advanced')}</p></section>`;}

function voiceReference(){return heading('语音 / 电脑端详细配置','更换参考录音，再生成新的运行副本','免费系统声音已有一键配置；这里讲的是进阶 CosyVoice3 定制音色。')+`<section class="paper voice-reference"><h2>只想让她说话？</h2><p>先用「设置 → 语音 → 一键配置语音」。下面的安装步骤仅用于进阶 AI 音色。</p><h2>首次准备 AI 音色需要什么？</h2><p>需要电脑端 audio.cpp 程序、与该引擎匹配的 CosyVoice3 GGUF 模型、参考录音和对应文字。先在语音引擎中生成一句话，确认能播放，再接入 DSH 桥接。</p><p>${official('audio.cpp 安装与模型说明','https://github.com/0xShug0/audio.cpp')}${official('CosyVoice 官方模型与许可','https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512')}${official('官方示例录音','https://github.com/QwenAudio/CosyVoice/blob/main/asset/zero_shot_prompt.wav')}</p><p>模型文件必须与引擎格式匹配，不能把其他引擎的同名 GGUF 直接混用。下面的现有准备脚本适用于已经配置好的源目录，不是通用下载安装器。</p><h2>已有源目录：如何更换音色？</h2><ol><li>保留当前可用的语音目录。复制一份上游引擎的源安装目录，后续只编辑这个新副本。</li><li>在新副本的 server.json 中找到语音模型。现有准备脚本查找的内部模型 id 为 cosyvoice3-feiyu，family 为 cosyvoice3，task 为 clon，mode 为 offline；这个 id 是脚本使用的键名。</li><li>把该模型的 default_voice_preset.voice_ref 改为新录音的绝对路径，default_voice_preset.reference_text 改为录音里的原话。Windows 使用纯英文目录，例如 D:/FishVoice/source-new/refs/sample.wav。</li><li>确认源目录包含 bin64 程序目录、可访问的模型与参考录音。然后在本项目根目录运行下面的命令，生成一个尚不存在的新运行目录。</li></ol><pre>node scripts/prepare-isolated-tts.mjs D:/FishVoice/source-new D:/FishVoice/runtime-new</pre><p>这个脚本复制引擎、模型和参考录音，并为新目录生成完整的 manifest.json。不要直接覆盖已封存目录里的 refs/voice.wav；只改录音会导致安装校验失败。</p><ol start="5"><li>在当前 DSH 桥接私有配置的 mediaOptions.ttsRoot 中填写新目录的绝对路径。若还没有媒体适配器，还需按项目 DSH-BRIDGE 文档准备 mediaAdapter 和 attachmentsRoot；基础转文字由一键配置自动准备；没有可直接粘贴到所有电脑的统一路径。</li><li>等当前任务完成，按当前 DSH 版本的方式重新加载对应聊天的桥接，让它读取新目录。若之前使用免费声音，先在「设置 → 语音」点「恢复原来的 AI 音色」，这会保留转文字。确认「发送语音回复」工具出现，再到「设置此聊天 → 能力与权限」启用并保存。</li><li>回聊天请求一条短语音，播放核对新音色。没有声音或音色不对时，恢复原 ttsRoot 并重新加载对应桥接。</li></ol><h2>A 卡的 HIP 接入</h2><p>先按官方说明验证 HIP 引擎。新的运行目录需使用匹配的引擎、backend 为 hip、threads 为 4，再重新生成完整文件校验。当前准备脚本默认生成 CPU 目录，不能只把配置改成 hip 而不更新校验。</p><h2>免费参考录音</h2><p>CosyVoice 官方示例文件为 zero_shot_prompt.wav，页面可下载原文件；对应原话为「希望你以后能够做的比我还好呦。」。模型公开不等于所有第三方音色素材都可任意使用。</p><h2>不想碰配置文件？</h2><p>准备 WAV 后，可以<a href="#voice/agent/custom">复制配置提示词给 DSH / Codex</a>，让能执行本地命令的 Agent 完成准备、接入和试听。录音原话有就一起放，没有时让它先转写；不兼容的环境会说明具体缺口。</p><p>${button('返回一步步教学','walk/voice/0',true)} ${button('显卡加速放进阶','voice/advanced')}</p></section>`;}

const easyViews={welcome:easyHome,start:()=>wizard('start',0),move:()=>easyChoice('旧资料在哪个软件里？','只选你以前使用的那个。',[
  ['AstrBot','从原控制台导出聊天。','migration/astrbot'],
  ['WeChatAgent','先确认是否已经有转换好的资料包。','migration/wechatagent']
]),'migration/astrbot':()=>sourceChoice('astrbot'),'migration/wechatagent':()=>sourceChoice('wechatagent'),'memory/astrbot':()=>memoryHelp('astrbot'),'memory/wechatagent':()=>memoryHelp('wechatagent'),'wechat-help':wechatHelp,plugins:()=>wizard('plugins',0),voice:voiceHome,'voice/free':voiceFree,'voice/hearing':voiceHearing,'voice/advanced':voiceAdvanced,'voice/custom':voiceCustom,'voice/nvidia-status':nvidiaStatus,'voice/singing-gpu/amd':()=>singingGpu('amd'),'voice/singing-gpu/nvidia':()=>singingGpu('nvidia'),'voice/amd':()=>voiceGpu('amd'),'voice/nvidia':()=>voiceGpu('nvidia'),phone:phonePrerequisite,'phone-network':phoneNetworkHelp,complete:easyComplete,later};
const content=document.getElementById('content');
let initialized=false;
let lastSimpleRoute='welcome';
function render(){
  const route=location.hash.slice(1)||'welcome',walk=/^walk\/(start|astrbot|wechat|plugins|freevoice|voice|singing|gpuamd|phone)\/(\d+)$/.exec(route),agentRoute=/^voice\/agent\/(basic|custom|singing|gpu)$/.exec(route),reference=route.startsWith('reference/')?route.slice(10):null;
  const referenceView=reference&&Object.hasOwn(referenceViews,reference)?referenceViews[reference]:null;
  if(!referenceView)lastSimpleRoute=Object.hasOwn(easyViews,route)||agentRoute||route==='voice/agent'||walk&&Number(walk[2])<tutorialFlows[walk[1]].steps.length?route:'welcome';
  document.body.classList.toggle('reference-mode',Boolean(referenceView));
  const referenceLink=document.getElementById('reference-link');
  const referenceTarget=walk?tutorialFlows[walk[1]].reference:agentRoute?.[1]==='singing'?'singing':Object.hasOwn(referenceViews,route)?route:route==='wechat-help'?'migration/wechatagent':route.startsWith('memory/')?'migration/'+route.slice(7):route.startsWith('voice/')?'voice':'start';
  referenceLink.textContent=referenceView?'返回简明版':'详细说明';
  referenceLink.href=referenceView?'#'+lastSimpleRoute:'#reference/'+referenceTarget;
  if(referenceView){content.innerHTML=`<nav class="reference-nav" aria-label="详细说明章节"><a href="#reference/start">开始聊天</a><a href="#reference/migration/astrbot">AstrBot</a><a href="#reference/migration/wechatagent">WeChatAgent</a><a href="#reference/plugins">DSH 插件</a><a href="#reference/voice">语音与音色</a><a href="#reference/phone">手机</a></nav>`+referenceView();content.querySelectorAll('a[href^="#"]').forEach(link=>{const target=link.getAttribute('href').slice(1);if(Object.hasOwn(referenceViews,target))link.href='#reference/'+target;});}
  else if(agentRoute){content.innerHTML=agentSpeech(agentRoute[1]);document.getElementById('agent-prompt').value=speechAgentPrompt(agentRoute[1]);}
  else if(route==='voice/agent')content.innerHTML=agentSpeechChoice();
  else if(walk&&Number(walk[2])<tutorialFlows[walk[1]].steps.length)content.innerHTML=wizard(walk[1],Number(walk[2]));
  else content.innerHTML=(Object.hasOwn(easyViews,route)?easyViews[route]:easyHome)();
  document.title=(document.querySelector('h1')?.textContent||'一步一步来')+' · fish with me';
  if(initialized){window.scrollTo({top:0,behavior:'instant'});document.getElementById('page-title').focus({preventScroll:true});}
  initialized=true;
}
document.querySelector('[data-go="later"]').addEventListener('click',()=>{location.hash='later';});
document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();content.focus();});
content.addEventListener('click',async event=>{
  const copy=event.target.closest('[data-copy-speech]');if(!copy||copy.disabled)return;
  const text=document.getElementById('agent-prompt'),status=document.getElementById('agent-copy-status');copy.disabled=true;
  try{await navigator.clipboard.writeText(text.value);copy.textContent='已复制';status.textContent=['custom','singing'].includes(copy.dataset.copySpeech)?'已复制。把提示词和素材文件夹路径一起发给 Agent。':'已复制。发给 Agent，并告诉它要配置哪一段聊天。';}
  catch{text.closest('details').open=true;text.focus();text.select();status.textContent='未能自动复制。请长按或全选下面的文字，手动复制。';}
  finally{copy.disabled=false;}
});
addEventListener('hashchange',render);
render();
