import test from 'node:test';
import assert from 'node:assert/strict';
import {contextLimitDetails,modelHttpError} from './model-context-error.js';

test('classify nested capacity details before truncating a long error envelope',()=>{
  const error={error:{message:JSON.stringify({code:11115,padding:'x'.repeat(1500),msg:'prompt is too long: 1743408 tokens \\u003e 1048576 maximum'})}};
  const result=modelHttpError(400,'model',JSON.stringify(error));
  assert.equal(result.code,'MODEL_CONTEXT_REJECTED');
  assert.equal(result.inputTokens,1743408);assert.equal(result.windowTokens,1048576);
  assert.ok(result.message.length<300);
});

test('ordinary parameter and auth errors are not context rejections',()=>{
  assert.equal(contextLimitDetails({error:{message:'temperature must be positive'}}),null);
  assert.equal(modelHttpError(401,'model','context window is available only with a valid key').code,undefined);
});

test('capacity classifier understands old provider and persisted error spellings',()=>{
  for(const value of ['context_length_exceeded: maximum context length',
    {error:{code:'context_length_exceeded',message:'input rejected'}},
    'maximum context window exceeded','上下文长度超限',
    '模型 HTTP 400: {"error":{"message":"prompt is too long: 20 tokens > 10 maximum"}}'])assert.ok(contextLimitDetails(value));
});
