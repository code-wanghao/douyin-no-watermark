/**
 * 粘贴链接下载（不依赖客户端按钮）
 *
 * 思路：抖音的接口要 a_bogus 签名，我们算不出来；但分享页是给浏览器和社交预览用的，
 * 通常是服务端渲染、把作品数据直接写进 HTML。所以：
 *   短链 → 跟随跳转拿到 aweme_id → 抓分享页 → 从页面里挖出 JSON → 找无水印地址 → 下载
 *
 * 用法：
 *   node linkdl.mjs "https://v.douyin.com/xxxxx/"
 *   node linkdl.mjs --probe "链接"     只探测，报告挖到了什么，不下载
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { imageSizeOf } from './imgsize.mjs';
import { qualityCandidates } from './quality.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.DY_LINK_OUT || path.join(os.homedir(), 'Pictures', '抖音原图', '作品');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
  + ' (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const PROBE_ONLY = args.includes('--probe');
// 抖音"复制链接"复制的是一整段分享文字（文案 + 短链 + 提示语），所以要在整串里找 URL，
// 不能要求参数以 http 开头。
const linkArg = args.find((a) => /https?:\/\//i.test(a)) || '';

const say = (m) => process.stdout.write(m + '\n');
const log = (m) => { if (args.includes('--debug')) say('  [debug] ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从一整段分享文字里抠出第一个链接 */
function pickUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s，,。！!、]+/);
  return m ? m[0] : '';
}

/** 没有命令行参数时，自己从控制台读一行（避免把中文和特殊符号交给 cmd 传递） */
async function readLinkFromConsole() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('粘贴分享链接后回车: ', r));
  rl.close();
  return answer.trim();
}

/* ---------------- 拿页面 ---------------- */

async function get(url, ua = IPHONE_UA, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': ua,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: 'https://www.douyin.com/',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, url: res.url, text };
    } catch (e) {
      lastErr = e;
      log(`第 ${i + 1} 次失败: ${e.message}`);
      await sleep(1200);
    }
  }
  throw lastErr;
}

function pickAwemeId(str) {
  const m = String(str).match(/\/(?:video|note)\/(\d{6,})/)
    || String(str).match(/[?&](?:aweme_id|item_id|modal_id)=(\d{6,})/)
    || String(str).match(/\b(7\d{18})\b/);
  return m ? m[1] : '';
}

/* ---------------- 从 HTML 里挖 JSON ---------------- */

function tryParseJson(s) {
  const t = String(s).trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * 从 startIdx（必须是 { ）开始做括号配对，取出完整的对象字面量。
 * 不能用正则的 \{[\s\S]*?\} —— 非贪婪会在第一个 } 就停，嵌套对象必然被截断。
 */
function extractBalanced(text, startIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return '';
}

function extractJsonBlobs(html) {
  const blobs = [];
  const push = (v) => { if (v) blobs.push(v); };

  // window._ROUTER_DATA = {...};   ← 分享页的作品数据就在这里
  for (const m of html.matchAll(/_ROUTER_DATA\s*=\s*/g)) {
    const brace = html.indexOf('{', m.index + m[0].length);
    if (brace < 0) continue;
    push(tryParseJson(extractBalanced(html, brace)));
  }

  // <script> 里的纯 JSON，或 "var x = {...}" 这类赋值
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim();
    push(tryParseJson(raw));
    const brace = raw.indexOf('{');
    if (brace >= 0 && brace < 200) push(tryParseJson(extractBalanced(raw, brace)));
    try { push(tryParseJson(decodeURIComponent(raw))); } catch { /* 不是 URL 编码 */ }
  }
  return blobs;
}

/** 深度遍历，把作品信息挖出来 */
function harvest(obj) {
  const result = { videos: new Set(), images: new Set(), desc: '', author: '', awemeId: '', raw: null };
  const seen = new Set();
  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    if (typeof node.desc === 'string' && node.desc && !result.desc) result.desc = node.desc;
    if (node.author && typeof node.author === 'object' && node.author.nickname && !result.author) {
      result.author = node.author.nickname;
    }
    if ((node.aweme_id || node.awemeId) && !result.awemeId) result.awemeId = String(node.aweme_id || node.awemeId);

    // 播放地址：play_addr / playApi / bit_rate[].play_addr
    for (const field of ['play_addr', 'play_addr_lowbr', 'play_addr_265']) {
      const list = (node[field] && node[field].url_list) || [];
      for (const u of list) if (typeof u === 'string' && /^https?:/.test(u)) result.videos.add(u);
    }
    for (const br of (Array.isArray(node.bit_rate) ? node.bit_rate : [])) {
      const list = (br && br.play_addr && br.play_addr.url_list) || [];
      for (const u of list) if (typeof u === 'string' && /^https?:/.test(u)) result.videos.add(u);
    }
    // 图文
    if (Array.isArray(node.images)) {
      for (const im of node.images) {
        for (const u of ((im && im.url_list) || [])) {
          if (typeof u === 'string' && /^https?:/.test(u) && !/watermark/i.test(u)) result.images.add(u);
        }
      }
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return result;
}

/* ---------------- 下载 ---------------- */

function extOf(url) {
  const m = String(url).split('?')[0].match(/\.([A-Za-z0-9]{2,5})$/);
  const e = m ? m[1].toLowerCase() : '';
  return /^(jpe?g|png|webp|gif|bmp|avif|heic)$/.test(e) ? (e === 'jpeg' ? 'jpg' : e) : 'jpg';
}

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40) || '作品';
}

/** 读代理落盘的作品索引（你在客户端里看过的作品，地址都在这儿） */
function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'works-index.json'), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function fetchBuf(url, capBytes = 300 * 1024 * 1024) {
  const res = await fetch(url, {
    headers: { referer: 'https://www.douyin.com/', 'user-agent': DESKTOP_UA, range: 'bytes=0-' },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > capBytes) throw new Error('文件过大');
  return buf;
}

async function downloadToFile(url, file) {
  const buf = await fetchBuf(url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  let raw = linkArg;
  if (!raw) raw = await readLinkFromConsole();

  const url = pickUrl(raw);
  if (!url) {
    say('');
    say('× 这段文字里没找到链接。');
    say('  请用抖音的"分享 → 复制链接"，粘贴过来的应该形如：');
    say('  7.46 xxx... https://v.douyin.com/xxxxx/ 复制此链接...');
    return 1;
  }

  say(`· 识别到链接: ${url}`);
  let awemeId = pickAwemeId(url);

  // 1) 短链跟随跳转
  if (!awemeId) {
    say('· 正在解析短链…');
    const head = await get(url, IPHONE_UA);
    log(`跳到: ${head.url}`);
    awemeId = pickAwemeId(head.url) || pickAwemeId(head.text);
    if (awemeId) say(`· 解析出作品 id: ${awemeId}`);
  } else {
    say(`· 链接里直接就有作品 id: ${awemeId}`);
  }

  if (!awemeId) {
    say('× 没能从链接里解析出作品 id。');
    say('  请确认复制的是"分享链接"（形如 https://v.douyin.com/xxxxx/）。');
    return 2;
  }

  // 2) 抓分享页（服务端渲染）
  const pages = [
    `https://www.iesdouyin.com/share/video/${awemeId}/`,
    `https://www.douyin.com/video/${awemeId}`,
  ];
  let best = null;
  for (const pageUrl of pages) {
    say(`· 抓取 ${pageUrl}`);
    let page;
    try {
      page = await get(pageUrl, IPHONE_UA);
    } catch (e) {
      say(`  × 请求失败: ${e.message}`);
      continue;
    }
    say(`  状态 ${page.status}，${(page.text.length / 1024).toFixed(0)} KB，最终地址 ${page.url.slice(0, 90)}`);

    const blobs = extractJsonBlobs(page.text);
    say(`  从页面里解析出 ${blobs.length} 段 JSON`);
    let found = null;
    for (const b of blobs) {
      const r = harvest(b);
      if (!found || (r.videos.size + r.images.size) > (found.videos.size + found.images.size)) found = r;
    }
    if (found && (found.videos.size || found.images.size)) {
      say(`  ✓ 挖到 ${found.videos.size} 个视频地址 / ${found.images.size} 张图`);
      best = found;
      if (found.awemeId) best.awemeId = found.awemeId;
      break;
    }
    say('  这段页面里没挖到地址（可能是纯前端渲染）');
  }

  if (!best) {
    // 兜底：代理那侧如果收集过这个作品（你在客户端里打开过它），直接用它记下的地址
    say('');
    say('· 分享页没挖到数据，看看代理有没有收集过这个作品…');
    const idx = loadIndex();
    const hit = idx.find((w) => String(w.awemeId) === String(awemeId));
    if (hit && (hit.videoUrl || (hit.imageUrls || []).length)) {
      say(`  ✓ 找到了（作者：${hit.author || '未知'}）—— 你在客户端里看过它`);
      best = {
        videos: new Set(hit.videoUrl ? [hit.videoUrl] : []),
        images: new Set(hit.imageUrls || []),
        desc: hit.desc || '',
        author: hit.author || '',
        awemeId,
      };
    } else {
      say('  × 索引里也没有这个作品。');
      say('');
      say('× 两条路都没走通。');
      say('  可行做法：先开着代理、在客户端里打开这个视频（不用点下载），');
      say('           再运行本工具粘贴链接，就能从索引里命中。');
      return 3;
    }
  }

  best.awemeId = best.awemeId || awemeId;
  const who = sanitize(best.author || '未知作者');
  const what = sanitize(best.desc || best.awemeId);

  say('');
  say(`作者: ${best.author || '(未取到)'}`);
  say(`文案: ${(best.desc || '').slice(0, 50) || '(未取到)'}`);
  if (best.videos.size) {
    say('视频候选:');
    for (const u of best.videos) say('  ' + u.slice(0, 130));
  }
  if (best.images.size) {
    say(`图片候选: ${best.images.size} 张`);
    for (const u of [...best.images].slice(0, 5)) say('  ' + u.slice(0, 130));
  }

  if (PROBE_ONLY) {
    say('');
    say('（--probe 模式：只探测，不下载）');
    return 0;
  }

  // 3) 下载
  let ok = 0;
  if (best.videos.size) {
    const file = path.join(OUT_DIR, `${who}_${what}.mp4`);
    for (const u of best.videos) {
      try {
        const size = await downloadToFile(u, file);
        say(`✓ 视频已保存: ${file}  ${(size / 1048576).toFixed(1)} MB`);
        ok++;
        break;
      } catch (e) {
        say(`× 下载失败: ${e.message}`);
      }
    }
  } else if (best.images.size) {
    const folder = path.join(OUT_DIR, `${who}_${what}`);
    let n = 0;
    for (const [i, u] of [...best.images].entries()) {
      try {
        await downloadToFile(u, path.join(folder, `${String(i + 1).padStart(2, '0')}.${extOf(u)}`));
        n++;
      } catch (e) {
        say(`× 第 ${i + 1} 张失败: ${e.message}`);
      }
    }
    say(`✓ 图文 ${n}/${best.images.size} 张已保存到: ${folder}`);
    ok = n ? 1 : 0;
  }

  say('');
  say(ok ? `完成，保存在 ${OUT_DIR}` : '× 下载失败');
  return ok ? 0 : 4;
}

main()
  .then((c) => process.exit(c ?? 0))
  .catch((e) => {
    say('出错: ' + (e?.stack || e));
    process.exit(1);
  });
