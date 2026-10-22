import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {diffTreeMarkdown} from './tree-diff.js';

// Scope reduction is conservative: it is not a cached pass. A separate model
// still checks coverage and report semantics. New executable work keeps tools.
export async function parentReportScope({workspace,candidatePath,sourceCommit,nodeId,summary,receipt,onDecision=()=>{}}) {
  const decline=(reason,detail)=>{onDecision({reason,detail});return false;};
  if(!receipt?.ok || receipt.status!=='accepted' || !receipt.reviewBaselineCommit || receipt.sharedContract?.trim()
    || !receipt.jobs?.length || receipt.jobs.some(j=>j.status!=='completed'||j.review?.verdict!=='pass'||!j.review.evidence?.length))return decline('receipt-not-reusable',{ok:receipt?.ok,status:receipt?.status,baseline:!!receipt?.reviewBaselineCommit,sharedContract:!!receipt?.sharedContract,reviewedJobs:receipt?.jobs?.filter(j=>j.status==='completed'&&j.review?.verdict==='pass'&&j.review.evidence?.length).length});
  try {if(!await workspace.sameVersion(candidatePath,receipt.reviewBaselineCommit,sourceCommit))return decline('baseline-changed');}catch{return decline('baseline-unavailable');}
  const fields=new Set(['Completion','CurrentResult','NextIdea','Output']);
  let trees=0;
  for(const file of summary.changedFiles) {
    if(/^versions\/(?:subtrees\/[^/]+\/)?[^/]+\.md$/.test(file))continue;
    if(file!=='task-tree.md'&&!/^(trees|subtrees)\/[^/]+\.md$/.test(file))return decline('new-artifact',file);
    let before,after;
    try {before=await workspace.readVersion(candidatePath,sourceCommit,file);after=await readFile(path.join(candidatePath,file),'utf8');}catch{return decline('tree-unavailable',file);}
    const changes=diffTreeMarkdown(before,after);
    if(changes.some(c=>c.kind!=='node-field'||c.nodeId!==nodeId||!fields.has(c.field)))return decline('non-report-tree-change',changes);
    // Reject changes to edges, unknown lines, extra text, or multiline reports
    // not represented in the semantic diff. Only these simple fields commute.
    const mask=text=>text.replace(/^-\s+(Completion|CurrentResult|NextIdea|Output):[^\n]*(?:\n|$)/gm,'')
      .replace(/^(?:- NextPlan:[ \t]*|- ChainForceNext:[ \t]*)\r?\n/gm,'');
    if(mask(before)!==mask(after))return decline('tree-structure-or-untracked-prose',file);
    trees++;
  }
  onDecision({reason:trees>0 || summary.changedFiles.length===0?'report-only':'backup-only'});
  return trees>0 || summary.changedFiles.length===0;
}
