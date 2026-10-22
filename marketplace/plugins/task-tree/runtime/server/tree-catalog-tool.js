// Shared by the web model bridge and MCP: every agent sees the same contract.
export const TREE_CATALOG_TOOL = {
  name:'task_tree_registry',
  description:'管理当前项目的独立树下拉框：list 列出已接入树；create 新建独立树并登记，可直接传完整 markdown；register 接入已有独立树文件，不覆盖正文。独立树用 trees/<id>.md，返回 treeId、path、url；再用 task_tree_read/write(treeId,...) 编辑。扩展当前节点应改用 task_tree_subtree(write,foldRoot,path,markdown)，它会同时链接父节点；不要把子树单独登记成重复的独立树。不会切换用户活动树。完整示例见 llm-task-tree/skills/task-tree-grill/references/tree-connections.md。',
  parameters:{type:'object',additionalProperties:false,required:['action'],properties:{
    action:{type:'string',enum:['list','create','register']},
    id:{type:'string',description:'独立树 ID，例如 people'},title:{type:'string',description:'简洁中文树名'},
    path:{type:'string',description:'项目内相对路径，例如 trees/people.md'},
    role:{type:'string',enum:['method','background','architecture','experiments','reference']},
    description:{type:'string'},markdown:{type:'string',description:'仅 create 可用：完整独立树正文，含节点、GraphState、Edges；省略则建初始树'},
    reason:{type:'string'}
  }}
};
