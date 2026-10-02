/**
 * 客户端缓存索引
 *
 * 抖音电脑版会把接口响应缓存到磁盘（TTNetCache）。里面存着完整的作品数据：
 *   video.play_addr.url_list     无水印播放地址
 *   video.bit_rate[]             多档码率，每档都有自己的播放地址
 *   video_control.allow_download 是否允许下载（就是控制灰按钮那个）
 *   video_control.download_info.fail_info.msg
 *                                禁止下载时客户端弹的那句话
 *
 * 所以只要你在客户端里刷到过某个作品，它的无水印地址就已经躺在磁盘上了 ——
 * 不看按钮状态、不用重新请求、也不需要接口签名。
 *
 * 用法：node cacheindex.mjs [--build] [--json]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INDEX_FILE = path.join(HERE, 'cache-index.json');

const ROAM = process.env.DY_ROAM || path.join(os.homedir(), 'AppData', 'Roaming', 'douyin');
const DIRS = [
  path.join(ROAM, 'TTNetCache', 'disk_cache'),
  path.join(ROAM, 'Cache', 'Cache_Data'),
  path.join(ROAM, 'Partitions', 'annie-session', 'Cache', 'Cache_Data'),
];

/* ---------------- 工具 ---------------- */

/** 从 start 处的 { 开始做括号配对，取出完整对象（正则的非贪婪匹配会把嵌套对象截断） */
function balanced(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

function* walkCacheFiles() {
  for (const d of DIRS) {
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) yield p;
      } catch { /* 忽略 */ }
    }
  }
}

function variantsOf(buf) {
  const out = [buf];
  for (const fn of [zlib.gunzipSync, zlib.brotliDecompressSync, zlib.inflateSync]) {
    try {
      const r = fn(buf);
      if (r && r.length > 200) out.push(r);
    } catch { /* 换下一种 */ }
  }
  return out;
}

/* ---------------- 提取一个作品 ---------------- */

function bestPlayUrls(video) {
  // 优先 bit_rate 里码率最高的那几档（同一份画面的更高质量），再退回 play_addr
  const tiers = [];
  if (Array.isArray(video.bit_rate)) {
    for (const br of video.bit_rate) {
      const url = br && br.play_addr && br.play_addr.url_list && br.play_addr.url_list[0];
      if (!url) continue;
      tiers.push({
        url,
        uri: (br.play_addr && br.play_addr.uri) || '',
        bitRate: Number(br.bit_rate) || 0,
        width: br.play_addr.width || 0,
        height: br.play_addr.height || 0,
      });
    }
  }
  tiers.sort((a, b) => b.bitRate - a.bitRate);
  const top = tiers[0];
  const fallback = [];
  const fallbackUris = [];
  for (const f of ['play_addr', 'play_addr_h264', 'play_addr_265', 'play_addr_lowbr']) {
    const url = video[f] && video[f].url_list && video[f].url_list[0];
    if (url && !fallback.includes(url)) fallback.push(url);
    const uri = video[f] && video[f].uri;
    if (uri && !fallbackUris.includes(uri)) fallbackUris.push(uri);
  }
  return {
    best: (top && top.url) || fallback[0] || '',
    tiers: tiers.slice(0, 12).map((t) => t.url),
    fallback,
    // uri 是视频的永久编号，不会过期；用它去 /aweme/v1/play/ 换新鲜的下载地址
    playUri: (top && top.uri) || fallbackUris[0] || '',
    tierUris: tiers.slice(0, 12).map((t) => t.uri).filter(Boolean),
    fallbackUris,
  };
}

function extractRecords(json) {
  const out = [];
  const seen = new Set();
  const stack = [json];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const id = node.aweme_id || node.awemeId;
    if (id) {
      const video = node.video;
      const images = Array.isArray(node.images) ? node.images : null;
      if (video || images) {
        const vc = node.video_control || {};
        const rec = {
          awemeId: String(id),
          desc: String(node.desc || '').replace(/\s+/g, ' ').slice(0, 60),
          author: (node.author && (node.author.nickname || node.author.unique_id)) || '',
          type: video ? 'video' : 'image',
          bestVideoUrl: '',
          videoTiers: [],
          playUri: '',
          tierUris: [],
          fallbackUris: [],
          imageUrls: [],
          allowDownload: vc.allow_download,
          preventDownloadType: vc.prevent_download_type,
          failMsg: (vc.download_info && vc.download_info.fail_info && vc.download_info.fail_info.msg) || '',
        };
        if (video) {
          const urls = bestPlayUrls(video);
          rec.bestVideoUrl = urls.best;
          rec.videoTiers = urls.tiers.length ? urls.tiers : urls.fallback;
          rec.playUri = urls.playUri;
          rec.tierUris = urls.tierUris;
          rec.fallbackUris = urls.fallbackUris;
        }
        if (images) {
          for (const im of images) {
            const u = (im && im.url_list || []).find((x) => typeof x === 'string' && !/watermark/i.test(x));
            if (u) rec.imageUrls.push(u);
          }
        }
        if (rec.bestVideoUrl || rec.imageUrls.length) out.push(rec);
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return out;
}

/* ---------------- 扫缓存 ---------------- */

export function scanCache({ onProgress } = {}) {
  const found = new Map();
  let files = 0;
  for (const file of walkCacheFiles()) {
    let data;
    try {
      const st = fs.statSync(file);
      if (st.size === 0 || st.size > 200 * 1024 * 1024) continue;
      data = fs.readFileSync(file);
    } catch { continue; }
    files++;
    if (onProgress && files % 200 === 0) onProgress(files, found.size);

    for (const buf of variantsOf(data)) {
      const text = buf.toString('utf8');
      if (!text.includes('"aweme_list"') && !text.includes('"aweme_detail"')) continue;
      for (const marker of ['{"aweme_list"', '{"aweme_detail"']) {
        let idx = text.indexOf(marker);
        while (idx >= 0) {
          const raw = balanced(text, idx);
          if (raw) {
            try {
              for (const rec of extractRecords(JSON.parse(raw))) {
                const prev = found.get(rec.awemeId);
                if (!prev
                  || (!prev.playUri && rec.playUri)
                  || (!prev.bestVideoUrl && rec.bestVideoUrl)
                  || (rec.videoTiers.length > (prev.videoTiers || []).length)) {
                  found.set(rec.awemeId, rec);
                }
              }
            } catch { /* 不是完整 JSON */ }
          }
          idx = text.indexOf(marker, idx + marker.length);
        }
      }
    }
  }
  return { files, records: [...found.values()] };
}

export function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(raw.records) ? raw : { builtAt: raw.builtAt || '', records: [] };
  } catch {
    return { builtAt: '', records: [] };
  }
}

export function buildIndex({ quiet = false } = {}) {
  const say = (m) => { if (!quiet) process.stdout.write(m + '\n'); };
  say('· 正在扫描客户端缓存…');
  const { files, records } = scanCache({
    onProgress: (n, hit) => say(`  …已扫 ${n} 个文件，认出 ${hit} 个作品`),
  });
  const payload = { builtAt: new Date().toISOString(), files, count: records.length, records };
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(payload, null, 1), 'utf8');
  } catch { /* 写不进去也能用 */ }
  say(`· 扫完 ${files} 个文件，认出 ${records.length} 个作品 → ${INDEX_FILE}`);
  return payload;
}

/* ---------------- CLI ---------------- */

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const payload = buildIndex();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(payload.records.slice(0, 20), null, 2) + '\n');
  } else {
    const blocked = payload.records.filter((r) => r.allowDownload === false);
    console.log('');
    console.log(`共 ${payload.records.length} 个作品，其中 ${blocked.length} 个是"作者禁止下载"的：`);
    for (const r of blocked.slice(0, 15)) {
      console.log(`  · ${r.author}｜${r.desc.slice(0, 24)}｜${r.awemeId}`
        + `${r.failMsg ? `｜${r.failMsg}` : ''}`);
    }
    if (blocked.length > 15) console.log(`  …还有 ${blocked.length - 15} 个`);
  }
}
