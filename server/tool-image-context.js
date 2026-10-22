import { createHash } from 'node:crypto';

export const TOOL_IMAGE_RECALL = {type:'function',function:{name:'tool_image_recall',
  description:'按reference重新查看本轮图片原图。图片获得一次成功模型响应后移出重复输入，原图仍可无损取回；不会删除用户附件或原始聊天，也不要求临时文件仍存在。',
  parameters:{type:'object',additionalProperties:false,required:['reference'],properties:{reference:{type:'string',minLength:1}}}}};

// Original bytes remain in this turn's memory. Only the request projection is
// reduced; never delete files, user attachments, dialogue or tool receipts.
export function createToolImageContext({onRelease=()=>{}}={}) {
  const originals=new Map(), groups=new WeakMap(), deliveredMessages=new WeakSet(), deliveredReferences=new Set();
  return {
    extract(result) {
      const images=[];
      const receiptFor=image=>{
        if(!['image/png','image/jpeg','image/webp'].includes(image.mimeType) || typeof image.data!=='string' || !image.data)throw new Error('图片工具返回了非法图像结果');
        const {data:omitted,...metadata}=image;
        // MCP audience is a transport contract, not an instruction to the LLM.
        // A user-facing graph preview must not become model vision input.
        if(image.annotations?.audience && !image.annotations.audience.includes('assistant'))return {...metadata,deliveredAs:'user-display'};
        const reference=this.remember(image,result.path);
        images.push({image,path:result.path,reference,recalled:result.imageRecall===true});
        return {...metadata,deliveredAs:'image_url',reference};
      };
      if(!result || typeof result!=='object' || Array.isArray(result))return {receipt:result,images};
      const receipt={...result};
      if(result.image)receipt.image=receiptFor(result.image);
      if(Array.isArray(result.content))receipt.content=result.content.map(block=>block.type==='image'?receiptFor(block):block);
      return {receipt,images};
    },
    remember(image, file){
      const reference='image-'+createHash('sha256').update(image.mimeType).update(':').update(image.data).digest('hex').slice(0,24);
      if(!originals.has(reference))originals.set(reference,{path:file,image});
      return reference;
    },
    track(message,references){
      if(groups.has(message))return;
      if(!references)references=(message.content||[]).filter(block=>block.type==='image_url').map(block=>{
        const url=block.image_url.url;
        const data=url.match(/^data:(image\/[\w.+-]+);base64,(.*)$/s);
        if(data)return this.remember({mimeType:data[1],data:data[2]});
        const reference='image-'+createHash('sha256').update(url).digest('hex').slice(0,24);
        originals.set(reference,{imageBlock:structuredClone(block)});
        return reference;
      });
      groups.set(message,references);
    },
    consumed(messages){
      for(const message of messages){
        const references=groups.get(message);
        if(!references)continue;
        deliveredMessages.add(message);
        references.forEach(reference=>deliveredReferences.add(reference));
      }
    },
    wasConsumed(reference){return deliveredReferences.has(reference);},
    recall(reference){
      const original=originals.get(reference);
      if(!original)throw new Error('本轮没有该图像引用；请用 view_image 重新读取原图，不根据占位符猜测内容');
      return original;
    },
    project(messages){
      let released=0,bytesSaved=0;
      const projected=messages.map(message=>{
        if(message.role==='user' && Array.isArray(message.content) && message.content.some(block=>block.type==='image_url'))this.track(message);
        const references=groups.get(message);
        if(!references || !Array.isArray(message.content))return message;
        // Called only after a complete successful response; failed requests,
        // capacity rejections and stream retries cannot acknowledge delivery.
        if(!deliveredMessages.has(message))return message;
        const remaining=message.content.filter(c=>c.type!=='image_url');
        const note='图片已随前次请求发送并收到模型响应，原图仍在本轮图像缓存；需要视觉细节请调用 tool_image_recall(reference)，不要根据引用猜测图像。引用：'+references.join('、');
        const content=remaining.every(c=>c.type==='text')?remaining.map(c=>c.text).join('\n')+'\n'+note:[...remaining,{type:'text',text:note}];
        const replacement={...message,content};
        released+=references.length;
        bytesSaved+=Buffer.byteLength(JSON.stringify(message))-Buffer.byteLength(JSON.stringify(replacement));
        return replacement;
      });
      if(released)onRelease({images:released,bytesSaved});
      return released?projected:messages;
    }
  };
}
