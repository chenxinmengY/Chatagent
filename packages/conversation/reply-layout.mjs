// Match the WeChat layout contract: the model chooses complete conversational
// units; delivery splits on blank lines, never on commas or a character count.
export function validReplyLimit(value){return Number.isInteger(value)&&value>=0&&value<=20;}
export function replyLayoutNotice(maxMessages=2){
 if(!validReplyLimit(maxMessages))throw Error('INVALID_REPLY_LIMIT');
 if(maxMessages===1)return '消息节奏：本轮只发送一条完整的文字回复，保留正文中的换行排版，不拆成多条。简短自然，代码块、完整列表、引用和连续说明保持完整。';
 const limit=maxMessages===0?'本轮不设固定条数上限，由你根据内容决定发送几条，避免机械碎片化':'本轮最多 '+maxMessages+' 条';
 return '消息节奏：能按独立意思自然分段的回复，优先分成多条聊天消息，不把结论、补充说明和追问挤在同一条里；'+limit+'。用一个空行分隔不同消息，单个换行只用于消息内部排版。每条保持完整自然；简短答复只发一条，不为分段增加内容，不按字数、空格或逗号硬切。代码块、完整列表、引用和需要连续阅读的说明保持完整。';
}
