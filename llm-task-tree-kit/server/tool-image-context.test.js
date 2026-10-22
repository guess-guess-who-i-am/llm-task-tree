import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolImageContext} from './tool-image-context.js';

test('ordinary array, primitive and text-only results keep their exact shape',()=>{
  const context=createToolImageContext();
  for(const result of [[{name:'skill'}],'text',null,42,{content:[{type:'text',text:'caption'}]}])
    assert.deepEqual(context.extract(result),{receipt:result,images:[]});
});

test('MCP multi-image extraction is lossless and original result remains unchanged',()=>{
  const context=createToolImageContext();
  const result={content:[{type:'image',mimeType:'image/png',data:'ORIGINAL_A',annotations:{audience:['assistant']}},
    {type:'text',text:'caption'},{type:'image',mimeType:'image/jpeg',data:'ORIGINAL_B'}]};
  const snapshot=structuredClone(result), {receipt,images}=context.extract(result);
  assert.deepEqual(result,snapshot);assert.equal(images.length,2);
  assert.ok(!JSON.stringify(receipt).includes('ORIGINAL_'));
  assert.deepEqual(receipt.content[0].annotations,{audience:['assistant']});
  assert.deepEqual(receipt.content[1],result.content[1]);
  for(const [i,block] of [result.content[0],result.content[2]].entries())
    assert.equal(context.recall(images[i].reference).image.data,block.data);
});

test('only successful model consumption releases an image, while originals and text remain intact',()=>{
  const context=createToolImageContext();
  const {images}=context.extract({image:{mimeType:'image/png',data:'ORIGINAL'}});
  const message={role:'user',content:[{type:'text',text:'精确附件说明'},{type:'image_url',image_url:{url:'data:image/png;base64,ORIGINAL'}}]};
  const snapshot=structuredClone(message);
  context.track(message,images.map(i=>i.reference));
  assert.equal(context.project([message])[0],message,'a failed request must not release its input');
  context.consumed([message]);
  const projected=context.project([message]);
  assert.equal(typeof projected[0].content,'string');
  assert.match(projected[0].content,/精确附件说明/);
  assert.ok(!JSON.stringify(projected).includes('base64,ORIGINAL'));
  assert.deepEqual(message,snapshot,'archive/caller objects stay unchanged');
  assert.equal(context.recall(images[0].reference).image.data,'ORIGINAL');
});

test('user-only MCP images are not delivered as model input',()=>{
  const context=createToolImageContext();
  const result=context.extract({content:[{type:'image',mimeType:'image/png',data:'USER_DISPLAY',annotations:{audience:['user']}},{type:'text',text:'任务图已生成'}]});
  assert.equal(result.images.length,0);
  assert.ok(!JSON.stringify(result.receipt).includes('USER_DISPLAY'));
  assert.equal(result.receipt.content[0].deliveredAs,'user-display');
});
