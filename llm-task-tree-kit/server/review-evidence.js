// An archive reference is not a truncated patch: both immutable Git versions
// and the full candidate file remain available to the checker's normal tools.
export function reviewEvidence(summary) {
  const archive=summary.deferredEvidence;
  if(!archive?.files?.length)return summary.patchPreview;
  return [summary.patchPreview,
    '大文件、数据集、运行日志、历史版本和二进制文件未内联；候选工作区与 Git 基线均保留原件。先用测试、统计和少量代表记录验证目标；确有验收需要时，只读取相关片段，不要把整份日志或数据集重新载入上下文。PDF等文档须按内容核验，不能仅凭路径声称已读。',
    `基线版本：${archive.baseCommit}；候选版本：${archive.candidateCommit}`,
    `待按需核验的文件：\n${archive.files.join('\n')}`
  ].join('\n\n');
}
