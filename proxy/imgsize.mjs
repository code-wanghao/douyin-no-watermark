/**
 * 从图片文件头读出真实像素尺寸和格式（webp / jpeg / png）。
 * 用途：下载完成后核对"拿到的到底是不是全尺寸原图"——
 * 把实测尺寸和接口声明的原始宽高对比，一致就说明 CDN 给的确实是原始分辨率。
 */

export function imageSizeOf(buf) {
  if (!buf || buf.length < 16) return null;
  try {
    // PNG
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), fmt: 'png' };
    }

    // WebP (RIFF....WEBP)
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), fmt: 'webp' };
      }
      if (fourcc === 'VP8 ') {
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, fmt: 'webp' };
      }
      if (fourcc === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, fmt: 'webp' };
      }
      return { w: 0, h: 0, fmt: 'webp' };
    }

    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        // SOS 之后就是熵编码数据，不再是段落结构。必须在这里停下，
        // 否则截断文件里会误认伪 SOF 标记，解析出完全离谱的尺寸。
        if (marker === 0xda) break;
        // SOF0..SOF15，排除 DHT(c4) / JPG(c8) / DAC(cc)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const segLen = buf.readUInt16BE(i + 2);
          const w = buf.readUInt16BE(i + 7);
          const h = buf.readUInt16BE(i + 5);
          // SOF 段长 = 8 + 3×分量数，最多几个分量，所以必然落在 8..32 之间。
          // 这一条能把"从垃圾数据里误认出的伪 SOF"直接筛掉。
          if (segLen >= 8 && segLen <= 32 && w > 0 && h > 0 && w <= 20000 && h <= 20000) {
            return { w, h, fmt: 'jpeg' };
          }
          return { w: 0, h: 0, fmt: 'jpeg' };
        }
        const segLen = buf.readUInt16BE(i + 2);
        if (segLen < 2) break;
        i += 2 + segLen;
      }
      return { w: 0, h: 0, fmt: 'jpeg' };
    }
  } catch {
    return null;
  }
  return null;
}
