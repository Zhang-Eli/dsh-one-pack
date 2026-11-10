// One Pack · vendor/zstdframe.mjs
// 改造自 dsh-github-sync/lib/zstdframe.mjs（MIT License，原作者 dsh-github-sync contributors）。
// 改动：仅保留 zstd 多帧读写算法本身，路径无关；不 import 任何 @deepseek-ai/* 包。
//
// zstd 多帧读写：DSH 会话文件是"多个独立 zstd 帧顺序拼接"，不是单个流。
// Node 的 zstdDecompressSync 只解第一帧，必须自己按帧头切分。
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 遍历所有帧，返回 [{ offset, length }]。
 * 帧布局：Magic(4) | Frame_Header_Descriptor(1) | [Window_Descriptor] | [Dictionary_ID] |
 *         [Frame_Content_Size] | Blocks... | [Content_Checksum(4)]
 * Block 头 3 字节小端：bit0=Last_Block, bit1-2=Block_Type, bit3-23=Block_Size
 */
export function walkFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    if (!buf.subarray(off, off + 4).equals(ZSTD_MAGIC)) {
      throw new Error(`不是 zstd 帧起点：offset=${off}（文件 ${buf.length} 字节）`);
    }
    const fhd = buf[off + 4];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const didFlag = fhd & 3;
    let p = off + 5;
    if (!single) p += 1;                        // Window_Descriptor
    p += [0, 1, 2, 4][didFlag];                 // Dictionary_ID
    p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    let last = 0;
    while (!last) {
      if (p + 3 > buf.length) throw new Error(`block 头越界：offset=${off}`);
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
      p += 3;
      if (type === 0) p += size;          // Raw
      else if (type === 1) p += 1;        // RLE
      else if (type === 2) p += size;     // Compressed
      else throw new Error(`保留 block 类型：offset=${p}`);
      if (p > buf.length) throw new Error(`帧越界：offset=${off}`);
    }
    if (checksum) p += 4;
    frames.push({ offset: off, length: p - off });
    off = p;
  }
  return frames;
}

export function decodeFrame(buf, frame) {
  return zstdDecompressSync(buf.subarray(frame.offset, frame.offset + frame.length));
}

/** 解出每一帧的文本（UTF-8） */
export function decodeFrames(buf) {
  return walkFrames(buf).map((f) => decodeFrame(buf, f).toString('utf8'));
}

/** 把文本数组按"一帧一段"重新压回去 */
export function encodeFrames(texts) {
  return Buffer.concat(texts.map((t) => zstdCompressSync(Buffer.from(t, 'utf8'))));
}

/** 单帧压缩：改写头帧时只换这一帧，尾部字节原样保留 */
export function encodeOne(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'));
}

export function frameStats(buf) {
  const frames = walkFrames(buf);
  return { frames: frames.length, bytes: buf.length };
}