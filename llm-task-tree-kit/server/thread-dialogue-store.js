import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { dialogueMessages } from './dialogue-state.js';

const writes = new Map();
const THREAD_ID = /^deepseek-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dialogueFile(codexHome, threadId) {
  if (typeof threadId !== 'string' || !THREAD_ID.test(threadId)) {
    throw new Error('非法 threadId：必须是 deepseek-UUID，不允许路径穿越');
  }
  const root = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(path.resolve(root), 'task-tree-dialogues', `${threadId}.json`);
}

export async function loadThreadDialogue({ codexHome, threadId } = {}) {
  const file = dialogueFile(codexHome, threadId);
  // Observe writes already queued at read time, never a partial replacement.
  if (writes.has(file)) await writes.get(file);
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state.threadId !== threadId) throw new Error('会话文件 threadId 与请求不符');
    return dialogueMessages(state.messages);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadThreadContext({ codexHome, threadId } = {}) {
  const file = dialogueFile(codexHome, threadId);
  if (writes.has(file)) await writes.get(file);
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state.threadId !== threadId) throw new Error('会话文件 threadId 与请求不符');
    return state.contextCache || null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Remove from the live lookup, preserving a private recoverable copy.
export async function archiveThreadDialogue({ codexHome, threadId } = {}) {
  const file = dialogueFile(codexHome, threadId);
  if (writes.has(file)) await writes.get(file);
  const folder = path.join(path.dirname(file), 'deleted');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    await rename(file, path.join(folder, `${threadId}-${randomUUID()}.json`));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function saveThreadDialogue({ codexHome, threadId, cwd, messages, contextCache } = {}) {
  const file = dialogueFile(codexHome, threadId);
  // Capture the full text now, not after waiting behind another write.
  const content = JSON.stringify({
    schema: 'task-tree-thread-dialogue/v1',
    threadId,
    cwd: typeof cwd === 'string' ? cwd : '',
    messages: dialogueMessages(messages),
    ...(contextCache ? { contextCache } : {}),
  });
  const previous = writes.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  });
  writes.set(file, operation);
  try {
    await operation;
  } finally {
    if (writes.get(file) === operation) writes.delete(file);
  }
}
