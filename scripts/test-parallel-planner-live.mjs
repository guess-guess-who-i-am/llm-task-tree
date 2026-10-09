import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildPlannerPrompt, requestDeepSeekPlanner, normalizeParallelPlan } from '../server/codex-coordinator.js';
import { localNetworkEnvironment } from '../server/network-environment.js';

// Read-only live inference in an isolated tree. No credentials are copied or logged.
const source = path.resolve(import.meta.dirname, '..');
const reuse = process.argv.find(arg => arg.startsWith('--reuse-thread='))?.split('=')[1];
if (reuse && !/^deepseek-[0-9a-f-]{36}$/.test(reuse)) throw new Error('invalid probe thread');
const prior = reuse ? JSON.parse(await readFile(path.join(os.homedir(), '.codex/task-tree-dialogues', reuse + '.json'), 'utf8')) : null;
if (prior && !path.basename(prior.cwd).startsWith('parallel-planner-live-')) throw new Error('not an isolated planner probe');
const fixture = prior?.cwd || await mkdtemp(path.join(os.tmpdir(), 'parallel-planner-live-'));
const markdown = '# LLM Task Graph\n## ROOT - 独立项目\n- Problem: 生成可并行完成的独立结果\n- Metrics: 不漏目标，不伪造已完成\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
if (!prior) await writeFile(path.join(fixture, 'task-tree.md'), markdown);
Object.assign(process.env, await localNetworkEnvironment());
process.env.TASK_TREE_GLOBAL_ENV_FILE ||= path.resolve(source, '../.env');
const started = performance.now();
let report;
try {
  const result = prior ? { output: prior.messages.at(-1).content } : await requestDeepSeekPlanner({ projectRoot: fixture,
    sourceTree: { id: 'method', path: 'task-tree.md' },
    prompt: buildPlannerPrompt(markdown, '在本隔离项目中创建六份互不依赖的中文说明，分别保存到 navigation.md、dialogue.md、attachments.md、subtrees.md、parallel.md、recovery.md，介绍各自的使用方法。每份都能独立完成，不需要测试、评审或额外的整合任务；本次只规划，不实际创建这些文件。') });
  assert.ok(result, 'configured planner required');
  const jobs = normalizeParallelPlan(result.output, markdown).jobs;
  assert.equal(jobs.filter(j => !j.dependsOn.length).length, 6);
  for (const name of ['navigation', 'dialogue', 'attachments', 'subtrees', 'parallel', 'recovery']) {
    assert.ok(jobs.some(job => JSON.stringify(job).includes(name + '.md')), `missing deliverable: ${name}`);
  }
  assert.equal(await readFile(path.join(fixture, 'task-tree.md'), 'utf8'), markdown);
  const priorReport = prior ? JSON.parse(await readFile(path.join(source, 'docs/parallel-planner-live.json'), 'utf8')) : null;
  report = { ok: true, fixture, wallMs: priorReport?.wallMs || Math.round(performance.now() - started), jobCount: jobs.length,
    readyCount: jobs.filter(j => !j.dependsOn.length).length, timing: result.timing,
    ...(prior ? { reusedProbeThread: reuse, parserCorrection: '测试复用生产计划解析器；原响应含说明及 JSON 代码块，生产解析器可正常提取。未重发模型请求。' } : {}),
    limitation: '真实 API 只读规划探针，未执行真实模型 Worker；完整工具与合并链路另由本机模型替身验证。' };
} catch (error) {
  report = { ok: false, fixture, wallMs: Math.round(performance.now() - started), error: error.message,
    limitation: '未声称真实 API 恢复或质量验证通过。' };
  process.exitCode = 1;
}
await writeFile(path.join(source, 'docs/parallel-planner-live.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
