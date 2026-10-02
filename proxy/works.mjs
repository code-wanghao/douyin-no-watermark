/**
 * 作品下载（从客户端缓存里读，不依赖下载按钮）
 *
 * 用法：
 *   node works.mjs              列出缓存里的作品，输入编号下载
 *   node works.mjs --blocked    只列"作者禁止下载"的
 *   node works.mjs 1,3,5        直接按编号下载
 *   node works.mjs --refresh    强制重新扫描缓存
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadIndex, buildIndex } from './cacheindex.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.DY_WORKS_OUT || path.join(os.homedir(), 'Pictures', '抖音原图', '作品');
const args = process.argv.slice(2);
const ONLY_BLOCKED = args.includes('--blocked');
const REFRESH = args.includes('--refresh');
const pickArg = (args.find((a) => /^[\d,\s]+$/.test(a)) || '').replace(/\s+/g, '');

const say = (m) => process.stdout.write(m + '\n');

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40) || '作品';
}

function extOf(url) {
  const m = String(url).split('?')[0].match(/\.([A-Za-z0-9]{2,5})$/);
  const e = m ? m[1].toLowerCase() : '';
  return /^(jpe?g|png|webp|gif|bmp|avif|heic)$/.test(e) ? (e === 'jpeg' ? 'jpg' : e) : 'jpg';
}

async function fetchBuf(url) {
  const res = await fetch(url, {
    headers: { referer: 'https://www.douyin.com/', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 缓存里的播放地址是带签名的，会过期（实测见过过期 12 天的）。
 * 但 play_addr.uri 是视频的永久编号 —— 用它请求播放跳转接口，能换到一个"新鲜的"地址。
 * 实测：HTTP 302 → 跟随后 206，直接拿到视频流。
 */
function playApiUrls(rec) {
  const uris = [rec.playUri, ...(rec.tierUris || []), ...(rec.fallbackUris || [])].filter(Boolean);
  const uniq = [...new Set(uris)];
  const out = [];
  for (const uri of uniq) {
    for (const ratio of ['1080p', '720p', '540p', '']) {
      const q = `video_id=${encodeURIComponent(uri)}${ratio ? `&ratio=${ratio}&line=0` : ''}`;
      out.push(`https://www.douyin.com/aweme/v1/play/?${q}`);
    }
  }
  // 最后再兜底用缓存里那个（可能已过期）的直链
  if (rec.bestVideoUrl) out.push(rec.bestVideoUrl);
  return out;
}

async function downloadWork(rec, i, total) {
  const tag = `${i}/${total}`.padEnd(7);
  const who = sanitize(rec.author || '未知作者');
  const what = sanitize(rec.desc || rec.awemeId);

  if (rec.imageUrls && rec.imageUrls.length) {
    const folder = path.join(OUT_DIR, `${who}_${what}`);
    let n = 0;
    for (const [k, u] of rec.imageUrls.entries()) {
      try {
        const buf = await fetchBuf(u);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, `${String(k + 1).padStart(2, '0')}.${extOf(u)}`), buf);
        n++;
      } catch { /* 跳过这张 */ }
    }
    say(`  ${tag}${who} · 图文 ${n}/${rec.imageUrls.length} 张`);
    return n > 0;
  }

  const urls = playApiUrls(rec);
  for (const [k, u] of urls.entries()) {
    try {
      const buf = await fetchBuf(u);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const file = path.join(OUT_DIR, `${who}_${what}.mp4`);
      fs.writeFileSync(file, buf);
      const src = urls[k].startsWith('https://www.douyin.com/aweme/v1/play/')
        ? (urls[k].match(/ratio=(\w+)/) || [])[1] || '默认'
        : '缓存直链';
      say(`  ${tag}${who} · ${(buf.length / 1048576).toFixed(1)} MB  (${src})`);
      return true;
    } catch (e) {
      if (k === urls.length - 1) say(`  ${tag}${who} · 失败（${e.message}）`);
    }
  }
  return false;
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(question, r));
  rl.close();
  return a.trim();
}

async function main() {
  let idx = REFRESH ? { builtAt: '', records: [] } : loadIndex();
  if (!idx.records.length) {
    idx = buildIndex();
    say('');
  } else {
    say(`· 用的缓存索引（${idx.builtAt ? idx.builtAt.slice(0, 19).replace('T', ' ') : '未知时间'}，${idx.records.length} 个作品）`);
    say('  想重新扫一遍：加 --refresh');
  }

  let list = idx.records.slice();
  if (ONLY_BLOCKED) list = list.filter((r) => r.allowDownload === false);
  if (!list.length) {
    say('缓存里没有作品。先在抖音电脑版里刷到你要的视频，再运行一次。');
    return 1;
  }

  say('');
  say(`共 ${list.length} 个作品${ONLY_BLOCKED ? '（只看禁止下载的）' : ''}：`);
  list.forEach((r, i) => {
    const blocked = r.allowDownload === false ? '【作者禁止下载】' : '';
    const kind = (r.imageUrls && r.imageUrls.length) ? `图文 ${r.imageUrls.length} 张` : '视频';
    say(`  ${String(i + 1).padStart(3)}. ${sanitize(r.author)}｜${r.desc.slice(0, 26)}｜${kind}${blocked}`);
  });
  say('');

  let picks = [];
  if (pickArg) {
    picks = pickArg.split(',').map((n) => Number(n)).filter((n) => n >= 1 && n <= list.length);
  } else {
    const ans = await ask('输入编号下载（可多个，如 1,3；直接回车＝不下载）： ');
    if (!ans) { say('已取消。'); return 0; }
    picks = ans.split(/[,，\s]+/).map((n) => Number(n)).filter((n) => n >= 1 && n <= list.length);
  }

  if (!picks.length) { say('没有有效的编号。'); return 1; }

  say('');
  say(`开始下载 ${picks.length} 个 → ${OUT_DIR}`);
  let ok = 0;
  for (const [i, n] of picks.entries()) {
    if (await downloadWork(list[n - 1], i + 1, picks.length)) ok++;
  }
  say('');
  say(`完成 ${ok}/${picks.length}`);
  return ok ? 0 : 2;
}

main()
  .then((c) => process.exit(c ?? 0))
  .catch((e) => {
    say('出错: ' + (e?.stack || e));
    process.exit(1);
  });
