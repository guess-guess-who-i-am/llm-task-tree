import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");

const WIDTH = 1600;
const HEIGHT = 900;
const FPS = 30;
const DURATION_SECONDS = 20;
const FRAME_COUNT = FPS * DURATION_SECONDS;
const port = process.env.PORT || "5410";
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.resolve("artifacts");
const sourceDir = path.join(outputDir, ".readme-story");
const browserExecutable = process.env.BROWSER_EXECUTABLE
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

await mkdir(outputDir, { recursive: true });
await rm(sourceDir, { recursive: true, force: true });
await mkdir(sourceDir, { recursive: true });

const localAppData = process.env.LOCALAPPDATA || "";
const ffmpegCandidates = [
  process.env.FFMPEG_EXECUTABLE,
  localAppData && path.join(
    localAppData,
    "Programs",
    "Python",
    "Python311",
    "Lib",
    "site-packages",
    "imageio_ffmpeg",
    "binaries",
    "ffmpeg-win-x86_64-v7.1.exe"
  ),
  "ffmpeg"
].filter(Boolean);
const ffmpegExecutable = ffmpegCandidates.find((candidate) => candidate === "ffmpeg" || existsSync(candidate));
assert(ffmpegExecutable, "ffmpeg is required; set FFMPEG_EXECUTABLE");

async function waitForProduct(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
}

async function closeOverview(page) {
  const dialog = page.locator("#projectOverviewDialog");
  if (await dialog.count() && await dialog.evaluate((element) => element.open)) {
    await page.locator("#projectOverviewClose").click();
  }
}

async function normalizedRegions(page, containerSelector, selectors) {
  return page.locator(containerSelector).evaluate((container, entries) => {
    const containerRect = container.getBoundingClientRect();
    return Object.fromEntries(Object.entries(entries).map(([name, selector]) => {
      const target = container.querySelector(selector);
      if (!target) throw new Error(`Missing storyboard region: ${selector}`);
      const rect = target.getBoundingClientRect();
      return [name, {
        x: (rect.left - containerRect.left) / containerRect.width,
        y: (rect.top - containerRect.top) / containerRect.height,
        width: rect.width / containerRect.width,
        height: rect.height / containerRect.height
      }];
    }));
  }, selectors);
}

async function captureProductSources() {
  const errors = [];
  const regions = {};
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404 (Not Found)")) errors.push(message.text());
  });

  try {
    await page.addInitScript(() => localStorage.clear());
    await waitForProduct(page);
    await closeOverview(page);
    await page.locator("#fitViewBtn").click();
    await page.waitForTimeout(800);
    regions.tree = await normalizedRegions(page, "#graphViewport", {
      root: '.graphNode[data-node-id="ROOT"]',
      direction: '.graphNode[data-node-id="N3"]',
      next: '.graphNode[data-node-id="N12"]'
    });
    await page.screenshot({ path: path.join(outputDir, "readme-tree-wide.png") });
    await page.locator("#graphViewport").screenshot({ path: path.join(sourceDir, "tree-canvas.png") });

    await page.locator("#projectOverviewBtn").click();
    await page.waitForFunction(() => document.querySelector("#projectOverviewDialog")?.open);
    await page.waitForTimeout(500);
    regions.overview = await normalizedRegions(page, "#projectOverviewDialog", {
      purpose: ".overviewThreePart--purpose",
      progress: ".overviewThreePart--progress",
      problem: ".overviewThreePart--problem"
    });
    await page.screenshot({ path: path.join(outputDir, "readme-overview-wide.png") });
    await page.locator("#projectOverviewDialog").screenshot({ path: path.join(sourceDir, "overview-card.png") });
    await page.locator("#projectOverviewClose").click();

    const demoNode = page.locator(".graphNode").filter({ hasText: "重构多树上下文与 Agent 维护闭环" }).first();
    assert.equal(await demoNode.count(), 1, "the focus-lens demo node is missing");
    await demoNode.click();
    await page.locator("#focusLensOpenBtn").click();
    await page.locator("#focusLens").waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outputDir, "readme-focus-wide.png") });
    await page.addStyleTag({ content: `
      .focusLensBody { display: block !important; overflow: visible !important; padding: 0 !important; }
      .focusLensCenter { width: 720px !important; margin: 0 auto !important; }
    ` });
    await page.waitForTimeout(100);
    regions.focus = await normalizedRegions(page, ".focusLensCenter", {
      problem: ".focusLensField--problem",
      approach: ".focusLensField--approach",
      result: ".focusLensField--result",
      next: ".focusLensNextWork",
      run: "[data-focus-lens-action='run-agent']"
    });
    await page.locator(".focusLensCenter").screenshot({ path: path.join(sourceDir, "focus-card.png") });

    await page.locator(".graphViewBtn[data-graph-view='flow']").click();
    await page.locator("#flowViewHost").waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outputDir, "readme-flow-wide.png") });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
  }
  return regions;
}

async function makeScore(outputPath) {
  const sampleRate = 48_000;
  const sampleCount = sampleRate * DURATION_SECONDS;
  const pcm = Buffer.alloc(sampleCount * 2);
  const beat = 60 / 96;
  let seed = 7119;

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const phase = time % beat;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = seed / 4294967295 * 2 - 1;
    const opening = Math.min(1, time / 0.7);
    const closing = Math.min(1, (DURATION_SECONDS - time) / 0.8);
    let sample = 0.011 * Math.sin(2 * Math.PI * 49 * time);
    sample += 0.007 * Math.sin(2 * Math.PI * 73.5 * time);
    sample += Math.exp(-phase * 22) * 0.018 * Math.sin(2 * Math.PI * 92 * time);

    for (const [moment, frequency] of [[2.7, 246], [7.5, 294], [12.5, 330], [17.8, 392]]) {
      const distance = time - moment;
      if (distance > -0.12 && distance < 0.5) {
        const envelope = Math.sin(Math.PI * Math.max(0, Math.min(1, (distance + 0.12) / 0.62)));
        sample += envelope * (0.018 * Math.sin(2 * Math.PI * frequency * time) + 0.006 * noise);
      }
    }

    if (time > 17.8) {
      const envelope = Math.min(1, (time - 17.8) / 0.8) * closing;
      sample += envelope * 0.014 * (
        Math.sin(2 * Math.PI * 196 * time)
        + Math.sin(2 * Math.PI * 247 * time)
        + Math.sin(2 * Math.PI * 294 * time)
      );
    }

    sample *= 7.0 * opening * closing;
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), index * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  await writeFile(outputPath, Buffer.concat([header, pcm]));
}

async function imageDataUrl(filePath) {
  return `data:image/png;base64,${(await readFile(filePath)).toString("base64")}`;
}

function storyboardHtml(assets, sourceRegions) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #f5f6f3; }
  canvas { display: block; width: 1600px; height: 900px; }
</style>
</head>
<body>
<canvas id="story" width="${WIDTH}" height="${HEIGHT}"></canvas>
<script>
const W=${WIDTH}, H=${HEIGHT};
const canvas=document.querySelector('#story');
const ctx=canvas.getContext('2d');
const urls=${JSON.stringify(assets)};
const regions=${JSON.stringify(sourceRegions)};
const images={};
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>{t=clamp(t);return t*t*(3-2*t)};
const fade=(t,a,b)=>ease((t-a)/(b-a));
const fontFamily='"Microsoft YaHei UI", "Noto Sans CJK SC", Arial, sans-serif';

function roundedRect(x,y,w,h,r=8){
  const radius=Math.min(r,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+radius,y);
  ctx.arcTo(x+w,y,x+w,y+h,radius);
  ctx.arcTo(x+w,y+h,x,y+h,radius);
  ctx.arcTo(x,y+h,x,y,radius);
  ctx.arcTo(x,y,x+w,y,radius);
  ctx.closePath();
}
function fillRounded(x,y,w,h,r,color){roundedRect(x,y,w,h,r);ctx.fillStyle=color;ctx.fill()}
function text(value,x,y,size,weight=500,color='#15201c',align='left'){
  ctx.font=weight+' '+size+'px '+fontFamily;
  ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillText(value,x,y);
}
function wrap(value,x,y,maxWidth,lineHeight,size,weight=500,color='#15201c',maxLines=4){
  ctx.font=weight+' '+size+'px '+fontFamily;ctx.fillStyle=color;ctx.textAlign='left';ctx.textBaseline='alphabetic';
  const chars=[...value],lines=[];let line='';
  for(const char of chars){const candidate=line+char;if(ctx.measureText(candidate).width>maxWidth&&line){lines.push(line);line=char}else line=candidate}
  if(line)lines.push(line);lines.slice(0,maxLines).forEach((item,index)=>ctx.fillText(item,x,y+index*lineHeight));
}
function imageContain(name,x,y,w,h,scale=1){
  const image=images[name],ratio=Math.min(w/image.width,h/image.height)*scale,dw=image.width*ratio,dh=image.height*ratio;
  const placement={x:x+(w-dw)/2,y:y+(h-dh)/2,width:dw,height:dh,clipX:x,clipY:y,clipWidth:w,clipHeight:h};
  ctx.drawImage(image,placement.x,placement.y,dw,dh);return placement;
}
function imageCover(name,x,y,w,h,scale=1,offsetX=0,offsetY=0){
  const image=images[name],ratio=Math.max(w/image.width,h/image.height)*scale,dw=image.width*ratio,dh=image.height*ratio;
  const placement={x:x+(w-dw)/2+offsetX,y:y+(h-dh)/2+offsetY,width:dw,height:dh,clipX:x,clipY:y,clipWidth:w,clipHeight:h};
  ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();ctx.drawImage(image,placement.x,placement.y,dw,dh);ctx.restore();return placement;
}
function mixColor(from,to,amount){
  const parse=value=>[1,3,5].map(index=>Number.parseInt(value.slice(index,index+2),16));
  const a=parse(from),b=parse(to),t=clamp(amount);
  return '#'+a.map((value,index)=>Math.round(lerp(value,b[index],t)).toString(16).padStart(2,'0')).join('');
}
function stageState(time,boundaries,transition=.22){
  return boundaries.reduce((state,boundary)=>state+fade(time,boundary-transition,boundary+transition),0);
}
function stageWeight(index,state){return clamp(1-Math.abs(index-state))}
function mappedRegion(placement,region){
  return {x:placement.x+region.x*placement.width,y:placement.y+region.y*placement.height,width:region.width*placement.width,height:region.height*placement.height};
}
function clipPlacement(placement){ctx.beginPath();ctx.rect(placement.clipX,placement.clipY,placement.clipWidth,placement.clipHeight);ctx.clip()}
function dimPlacement(placement,amount=.34){
  ctx.save();clipPlacement(placement);ctx.fillStyle='rgba(246,249,247,'+amount+')';ctx.fillRect(placement.clipX,placement.clipY,placement.clipWidth,placement.clipHeight);ctx.restore();
}
function spotlightRegion(name,placement,region,color,weight,scaleAmount=.025){
  if(!region||weight<=.002)return;
  const image=images[name],source={x:region.x*image.width,y:region.y*image.height,width:region.width*image.width,height:region.height*image.height};
  const base=mappedRegion(placement,region),zoom=1+scaleAmount*ease(weight),width=base.width*zoom,height=base.height*zoom;
  const target={x:base.x-(width-base.width)/2,y:base.y-(height-base.height)/2,width,height};
  ctx.save();clipPlacement(placement);roundedRect(target.x,target.y,target.width,target.height,7);ctx.clip();ctx.globalAlpha=.3+.7*weight;
  ctx.filter='saturate(1.1) contrast(1.04)';ctx.drawImage(image,source.x,source.y,source.width,source.height,target.x,target.y,target.width,target.height);ctx.filter='none';
  ctx.globalAlpha=.08*weight;ctx.fillStyle=color;ctx.fillRect(target.x,target.y,target.width,target.height);ctx.restore();
  ctx.save();clipPlacement(placement);ctx.globalAlpha=.35+.65*weight;ctx.strokeStyle=color;ctx.lineWidth=2+2*weight;ctx.shadowColor=color;ctx.shadowBlur=12*weight;
  roundedRect(target.x-2,target.y-2,target.width+4,target.height+4,8);ctx.stroke();ctx.restore();
}
function spotlightStages(name,placement,regionList,colors,state){
  dimPlacement(placement);
  regionList.forEach((region,index)=>spotlightRegion(name,placement,region,colors[index],stageWeight(index,state)));
}
function regionCenter(placement,region){const box=mappedRegion(placement,region);return{x:box.x+box.width/2,y:box.y+box.height/2}}
function spotlightPath(name,placement,regionList,colors,state){
  dimPlacement(placement,.38);
  ctx.save();clipPlacement(placement);ctx.lineCap='round';
  for(let index=1;index<regionList.length;index+=1){
    const progress=clamp(state-(index-1));if(progress<=0)continue;
    const from=regionCenter(placement,regionList[index-1]),to=regionCenter(placement,regionList[index]);
    ctx.globalAlpha=.3+.55*ease(progress);ctx.strokeStyle=colors[index];ctx.lineWidth=5+2*ease(progress);ctx.shadowColor=colors[index];ctx.shadowBlur=10*ease(progress);
    ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.bezierCurveTo(from.x,(from.y+to.y)/2,to.x,(from.y+to.y)/2,to.x,to.y);ctx.stroke();
  }
  ctx.restore();
  regionList.forEach((region,index)=>{
    const current=stageWeight(index,state),history=index < state ? .28 : 0;
    spotlightRegion(name,placement,region,colors[index],Math.max(current,history),.035);
  });
}
function clickPulse(placement,region,color,time,weight){
  if(!region||weight<=.002)return;
  const box=mappedRegion(placement,region),x=box.x+box.width/2,y=box.y+box.height/2,phase=(time%0.82)/0.82;
  ctx.save();clipPlacement(placement);ctx.globalAlpha=weight*(1-phase)*.8;ctx.strokeStyle=color;ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,10+34*phase,0,Math.PI*2);ctx.stroke();
  ctx.globalAlpha=.9*weight;ctx.fillStyle='#ffffff';ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=3;ctx.stroke();ctx.restore();
}
function sceneAlpha(t,start,end){return Math.min(fade(t,start,start+0.45),1-fade(t,end-0.45,end))}
function brand(x,y,color='#0e6a57'){
  fillRounded(x,y,44,44,7,color);ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(x+13,y+14);ctx.lineTo(x+31,y+14);ctx.moveTo(x+22,y+14);ctx.lineTo(x+22,y+31);
  ctx.moveTo(x+22,y+23);ctx.lineTo(x+13,y+31);ctx.moveTo(x+22,y+23);ctx.lineTo(x+31,y+31);ctx.stroke();
}
function sceneOpening(t){
  const a=sceneAlpha(t,0,3.05);if(a<=0)return;ctx.save();ctx.globalAlpha=a;ctx.fillStyle='#10231d';ctx.fillRect(0,0,W,H);
  const p=fade(t,0.2,1.0);brand(112,92,'#2f8a72');text('LLM Task Tree',174,126,24,700,'#dbeae4');
  ctx.save();ctx.translate(0,lerp(22,0,p));ctx.globalAlpha*=p;text('长对话之后，',112,350,54,650,'#b9ccc4');
  text('模型还记得为什么做吗？',112,444,76,760,'#f6faf7');ctx.fillStyle='#4ea88e';ctx.fillRect(112,505,132,6);
  text('把项目的当前事实留在对话之外。',112,565,28,520,'#aac0b7');ctx.restore();ctx.restore();
}
function stepRail(labels,state,x,y,colors){
  labels.forEach((label,index)=>{const weight=ease(stageWeight(index,state)),color=colors[index];ctx.fillStyle=mixColor('#ccd7d2',color,weight);ctx.fillRect(x,y+index*72,5,46);
    text(label,x+24,y+34+index*72,lerp(26,30,weight),Math.round(lerp(560,760,weight)),mixColor('#7b8883',color,weight));});
}
function sceneOverview(t){
  const start=2.65,end=7.75,a=sceneAlpha(t,start,end);if(a<=0)return;ctx.save();ctx.globalAlpha=a;ctx.fillStyle='#f4f6f3';ctx.fillRect(0,0,W,H);
  const local=t-start;text('01',94,112,18,800,'#0e6a57');text('先固定三件事',94,174,45,760,'#14241f');
  wrap('不让最后一句聊天覆盖项目原本要解决的问题。',94,222,390,39,24,520,'#66746e',3);
  const state=stageState(local,[1.65,3.25]),colors=['#2f6f5e','#4c7185','#b45d4c'];stepRail(['根本目标','当前进度','当前问题'],state,98,362,colors);
  fillRounded(500,68,1010,760,8,'#ffffff');ctx.save();ctx.shadowColor='rgba(25,50,41,.14)';ctx.shadowBlur=24;ctx.shadowOffsetY=12;
  const placement=imageContain('overview',510,78,990,740,0.98);ctx.restore();spotlightStages('overview',placement,[regions.overview.purpose,regions.overview.progress,regions.overview.problem],colors,state);
  ctx.strokeStyle='#cbd8d2';ctx.lineWidth=2;roundedRect(500,68,1010,760,8);ctx.stroke();ctx.restore();
}
function pathChip(label,x,y,weight,color){
  const width=188,intensity=ease(weight),blend=Math.sqrt(intensity),fill=mixColor('#ffffff',color,blend);fillRounded(x,y,width,58,7,fill);ctx.strokeStyle=mixColor('#cbd8d2',color,blend);ctx.lineWidth=2+intensity;
  roundedRect(x,y,width,58,7);ctx.stroke();text(label,x+width/2,y+38,22,720,blend>.5?'#ffffff':'#486159','center');
}
function sceneTree(t){
  const start=7.4,end=12.8,a=sceneAlpha(t,start,end);if(a<=0)return;ctx.save();ctx.globalAlpha=a;ctx.fillStyle='#edf2ee';ctx.fillRect(0,0,W,H);
  text('02',94,104,18,800,'#0e6a57');text('树大了，先看方向',94,164,45,760,'#14241f');
  wrap('缩小时只保留阶段标题和主干，让每个下一步都有来处。',94,212,420,39,24,520,'#66746e',3);
  const local=t-start,state=stageState(local,[1.8,3.5],.24),colors=['#2f6f5e','#4c7185','#967a30'];pathChip('根本目标',94,390,stageWeight(0,state),colors[0]);text('→',300,428,30,700,'#789087','center');
  pathChip('当前方向',320,390,stageWeight(1,state),colors[1]);text('→',526,428,30,700,'#789087','center');pathChip('下一步思路',546,390,stageWeight(2,state),colors[2]);
  fillRounded(760,64,760,772,8,'#ffffff');ctx.save();ctx.shadowColor='rgba(25,50,41,.12)';ctx.shadowBlur=22;ctx.shadowOffsetY=10;
  const placement=imageCover('tree',780,84,720,732,1.02,0,0);ctx.restore();spotlightPath('tree',placement,[regions.tree.root,regions.tree.direction,regions.tree.next],colors,state);
  ctx.strokeStyle='#c7d5cf';ctx.lineWidth=2;roundedRect(760,64,760,772,8);ctx.stroke();
  text('ROOT  →  当前主干  →  NextIdea',94,692,25,740,'#0e6a57');text('下一步始终有出处。',94,752,38,760,'#14241f');ctx.restore();
}
function sceneAction(t,cover=false){
  const start=12.45,end=18.15,a=cover?1:sceneAlpha(t,start,end);if(a<=0)return;ctx.save();ctx.globalAlpha=a;ctx.fillStyle='#f6f7f4';ctx.fillRect(0,0,W,H);
  text('03',80,98,18,800,'#0e6a57');text('把方向交给 Agent',80,156,43,760,'#14241f');wrap('下一步不是聊天里的临时口令，而是可执行、可回写的共享状态。',80,204,420,38,23,520,'#66746e',3);
  const local=cover?0:t-start,state=cover?0:stageState(local,[1.65,3.35],.22),colors=['#967a30','#4c7185','#2f7661'];stepRail(['写清下一步','交给 Codex','结果回到树'],state,84,360,colors);
  fillRounded(568,44,942,812,8,'#ffffff');ctx.save();ctx.shadowColor='rgba(25,50,41,.15)';ctx.shadowBlur=28;ctx.shadowOffsetY=14;
  const placement=imageContain('focus',586,62,906,776,0.98);ctx.restore();dimPlacement(placement);
  spotlightRegion('focus',placement,regions.focus.next,colors[0],stageWeight(0,state));
  spotlightRegion('focus',placement,regions.focus.run,colors[1],stageWeight(1,state),.08);
  spotlightRegion('focus',placement,regions.focus.result,colors[2],stageWeight(2,state));
  clickPulse(placement,regions.focus.run,colors[1],local,stageWeight(1,state));
  ctx.strokeStyle='#bccdc5';ctx.lineWidth=2;roundedRect(568,44,942,812,8);ctx.stroke();
  text('NextIdea  →  Codex  →  CurrentResult',80,700,23,740,'#0e6a57');text('执行之后，事实回到树里。',80,758,36,760,'#14241f');
  if(cover){ctx.fillStyle='rgba(13,25,21,.42)';ctx.fillRect(0,0,W,H);ctx.beginPath();ctx.arc(800,450,66,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,.94)';ctx.fill();
    ctx.beginPath();ctx.moveTo(785,412);ctx.lineTo(785,488);ctx.lineTo(848,450);ctx.closePath();ctx.fillStyle='#13231e';ctx.fill();}
  ctx.restore();
}
function sceneClosing(t){
  const a=fade(t,17.8,18.25);if(a<=0)return;ctx.save();ctx.globalAlpha=a;ctx.fillStyle='#10231d';ctx.fillRect(0,0,W,H);brand(112,108,'#2f8a72');
  text('LLM Task Tree',174,142,24,700,'#dbeae4');text('让 Agent 的下一步，',112,398,58,650,'#b9ccc4');text('始终扣住根本目标。',112,490,76,780,'#f6faf7');
  ctx.fillStyle='#4ea88e';ctx.fillRect(112,548,162,6);text('根本目标 · 当前进度 · 当前问题 · 下一步',112,608,27,560,'#aac0b7');ctx.restore();
}
function renderAt(t,cover=false){ctx.clearRect(0,0,W,H);if(cover){sceneAction(15.6,true);return}sceneOpening(t);sceneOverview(t);sceneTree(t);sceneAction(t,false);sceneClosing(t)}
window.storyReady=Promise.all(Object.entries(urls).map(([name,url])=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{images[name]=image;resolve()};image.onerror=reject;image.src=url;}))).then(()=>renderAt(0));
window.renderAt=renderAt;
</script>
</body>
</html>`;
}

function startEncoder(audioPath, mp4Path) {
  let process;
  const done = new Promise((resolve, reject) => {
    process = spawn(ffmpegExecutable, [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-vcodec", "mjpeg", "-r", String(FPS), "-i", "pipe:0",
      "-i", audioPath, "-t", String(DURATION_SECONDS), "-c:v", "libx264", "-preset", "medium", "-crf", "19",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "144k", "-movflags", "+faststart", "-shortest", mp4Path
    ], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg exited ${code}`)));
  });
  return { process, done };
}

async function renderStory(sourceRegions) {
  const assets = {
    overview: await imageDataUrl(path.join(sourceDir, "overview-card.png")),
    tree: await imageDataUrl(path.join(sourceDir, "tree-canvas.png")),
    focus: await imageDataUrl(path.join(sourceDir, "focus-card.png"))
  };
  const audioPath = path.join(sourceDir, "readme-score.wav");
  const mp4Path = path.join(outputDir, "readme-demo.mp4");
  const webmPath = path.join(outputDir, "readme-demo.webm");
  const coverPath = path.join(outputDir, "readme-demo-cover.png");
  await makeScore(audioPath);

  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  try {
    await page.setContent(storyboardHtml(assets, sourceRegions), { waitUntil: "load" });
    await page.evaluate(() => window.storyReady);
    const encoder = startEncoder(audioPath, mp4Path);
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      await page.evaluate((time) => window.renderAt(time, false), frame / FPS);
      const jpeg = await page.screenshot({ type: "jpeg", quality: 94 });
      if (!encoder.process.stdin.write(jpeg)) await new Promise((resolve) => encoder.process.stdin.once("drain", resolve));
      if (frame % 120 === 0) console.log(`Rendered frame ${frame}/${FRAME_COUNT}`);
    }
    encoder.process.stdin.end();
    await encoder.done;
    await page.evaluate(() => window.renderAt(15.6, true));
    await page.screenshot({ path: coverPath });
  } finally {
    await page.close();
    await browser.close();
  }

  const webm = spawnSync(ffmpegExecutable, [
    "-y", "-loglevel", "error", "-i", mp4Path, "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1",
    "-c:a", "libopus", "-b:a", "128k", webmPath
  ], { stdio: "inherit", windowsHide: true });
  assert.equal(webm.status, 0, `webm transcode failed with status ${webm.status}`);
  await rm(audioPath, { force: true });
}

const sourceRegions = await captureProductSources();
await renderStory(sourceRegions);
await rm(sourceDir, { recursive: true, force: true });
console.log(`Rendered a ${DURATION_SECONDS}s evidence-led README story from ${baseUrl}`);
