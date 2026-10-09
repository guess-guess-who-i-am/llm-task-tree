import { prewarmImageOcr } from '../server/chat-attachments.js';
try {
  await prewarmImageOcr();
  console.log('图片文字识别已预热；上传时复用已编译程序。');
} catch {
  console.warn('图片文字识别预热不可用；原图仍可发送给支持视觉的模型。');
}
