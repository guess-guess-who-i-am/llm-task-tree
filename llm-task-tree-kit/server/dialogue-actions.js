import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { dialogueMessages } from './dialogue-state.js';

export function reviseUserMessage(messages, index, content, attachments) {
  const history = dialogueMessages(messages);
  if (!Number.isInteger(index) || index < 0 || index >= history.length || history[index].role !== 'user') {
    throw Object.assign(new Error('只能编辑当前对话中存在的用户消息。'), { status: 400 });
  }
  if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('修改后的消息不能为空。'), { status: 400 });
  const refs = attachments ?? history[index].attachments;
  return [...history.slice(0, index), { role: 'user', content,
    ...(refs?.length ? { attachments: refs } : {}) }];
}

export function dialogueSnapshot(conversation, run) {
  const messages = dialogueMessages(conversation?.messages || run?.messages);
  const partial = String(run?.streams?.agentMessage?.text || run?.output || '');
  if (['starting', 'running', 'stopping'].includes(run?.status) && partial.trim()) messages.push({ role: 'assistant', content: partial });
  return messages;
}

export function dialogueMarkdown({ treeId, nodeId, title, status, messages, baseUrl = '' }) {
  const labels = { starting: '启动中', running: '运行中（当前快照）', stopping: '停止中（当前快照）', stopped: '已停止', completed: '已完成', failed: '已失败' };
  return [`# ${String(title || nodeId).replace(/\r?\n/g, ' ')} · 对话记录`, '',
    `树：${treeId} · 节点：${nodeId} · 状态：${labels[status] || status || '已保存'}`, '',
    ...dialogueMessages(messages).flatMap(message => [
      `## ${message.role === 'user' ? '你' : '模型'}`, '', message.content, '',
      ...(message.attachments || []).map(a => {
        const name = String(a.name || '附件').replace(/[\[\]\r\n]/g, '_');
        const url = baseUrl && a.url ? new URL(a.url, baseUrl).href : a.url || '';
        return `附件：[${name}](<${url}>)`;
      }), '',
    ])].join('\n');
}

export async function exportDialogueToDesktop(details, { desktopDir = path.join(os.homedir(), 'Desktop') } = {}) {
  await mkdir(desktopDir, { recursive: true });
  const nodeName = String(details.nodeId || '节点').replace(/[^\p{L}\p{N}_-]/gu, '_');
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const file = path.join(desktopDir, `对话-${nodeName}-${stamp}-${randomUUID().slice(0, 8)}.md`);
  await writeFile(file, dialogueMarkdown(details), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return file;
}
