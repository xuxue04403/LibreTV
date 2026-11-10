/**
 * HLS 探测：给一个 m3u8 地址，判断「能不能真的拉到视频分片」。
 *
 * 沿用旧脚本踩过的坑：
 * - master 列表要跟着变体走，且可能嵌套多层（非凡资源是 master → media）；
 * - VOD 列表的首尾分片偶发 404，只试一个就判死会误杀，必须多试几个；
 * - 分片返回 HTML（错误页）算失败，不能只看 HTTP 200。
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface HlsProbe {
  ok: boolean;
  /** 拿到的列表层级：0=直接是 media 列表，>0=跟了多少层 master */
  hostDepth: number;
  variants: number;
  segments: number;
  /** 实际拉通的分片字节数（0 表示没拿到） */
  bytes: number;
  ms: number;
  note: string;
}

interface HttpLike {
  request(url: string, options?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text: string;
    bytes: Uint8Array;
    headers: Record<string, string>;
  }>;
}

function lines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** 判断一块响应到底是不是视频（分片可能是 .ts / .m4s / .mp4 / .jpg 伪装） */
function looksLikeMedia(bytes: Uint8Array, contentType: string): boolean {
  if (bytes.byteLength < 1024) return false;
  if (/text\/html/i.test(contentType)) return false;
  if (/mpegurl/i.test(contentType)) return false;
  const b = bytes;
  // TS：0x47 同步字节
  if (b[0] === 0x47) return true;
  // fMP4 / MP4：ftyp box
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true;
  // JPEG 伪装
  if (b[0] === 0xff && b[1] === 0xd8) return true;
  // PNG 伪装
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  // 其他情况：只要不是 HTML/文本，且体积可观就当可用（编码各异，硬判容易误杀）
  return !/^(text|application\/json|application\/xml)/i.test(contentType) && bytes.byteLength > 20_000;
}

/**
 * 探测一个 HLS 地址。
 * @param pickRatio 尝试哪几个分片，默认首/中/尾各一个
 */
export async function probeHls(
  http: HttpLike,
  url: string,
  opts: { timeoutMs?: number; listTimeoutMs?: number; pickRatio?: number[] } = {}
): Promise<HlsProbe> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const listTimeoutMs = opts.listTimeoutMs ?? 12_000;
  const out: HlsProbe = { ok: false, hostDepth: 0, variants: 0, segments: 0, bytes: 0, ms: 0, note: '' };
  const headers = { 'User-Agent': BROWSER_UA };

  let base = url;
  let body: string;
  try {
    let res = await http.request(base, { timeoutMs: listTimeoutMs, headers });
    if (!res.ok) {
      out.note = `列表 HTTP ${res.status}`;
      out.ms = Date.now() - started;
      return out;
    }
    if (!res.text.includes('#EXTM3U')) {
      out.note = `非 m3u8（${res.headers['content-type'] ?? '?'}）`;
      out.ms = Date.now() - started;
      return out;
    }
    body = res.text;

    // 逐层跟随 master，最多 3 层，防止写坏了的循环引用
    for (let depth = 0; depth < 3; depth += 1) {
      const variants = (body.match(/#EXT-X-STREAM-INF/g) ?? []).length;
      if (variants === 0) break;
      out.variants = Math.max(out.variants, variants);
      out.hostDepth = depth + 1;
      const first = lines(body)[0];
      if (!first) {
        out.note = 'master 无变体地址';
        out.ms = Date.now() - started;
        return out;
      }
      base = new URL(first, base).toString();
      res = await http.request(base, { timeoutMs: listTimeoutMs, headers });
      if (!res.ok) {
        out.note = `变体 HTTP ${res.status}`;
        out.ms = Date.now() - started;
        return out;
      }
      body = res.text;
    }

    const segs = lines(body);
    out.segments = segs.length;
    if (segs.length === 0) {
      out.note = 'media 列表无分片';
      out.ms = Date.now() - started;
      return out;
    }

    const ratios = opts.pickRatio ?? [0, 0.5, 1];
    const picked = [...new Set(ratios.map((r) => Math.min(segs.length - 1, Math.max(0, Math.round(r * (segs.length - 1))))))];
    let lastNote = '';
    for (const idx of picked) {
      const segUrl = new URL(segs[idx], base).toString();
      try {
        const seg = await http.request(segUrl, { timeoutMs, headers });
        const ct = seg.headers['content-type'] ?? '';
        if (seg.ok && looksLikeMedia(seg.bytes, ct)) {
          out.ok = true;
          out.bytes = seg.bytes.byteLength;
          out.ms = Date.now() - started;
          out.note = `分片 #${idx} ${seg.bytes.byteLength}B`;
          return out;
        }
        lastNote = `分片 #${idx} HTTP ${seg.status} ${ct.slice(0, 24)} ${seg.bytes.byteLength}B`;
      } catch (err) {
        lastNote = `分片 #${idx} 失败 ${err instanceof Error ? err.message.slice(0, 40) : ''}`;
      }
    }
    out.note = lastNote || '所有抽样分片均失败';
    out.ms = Date.now() - started;
    return out;
  } catch (err) {
    out.note = err instanceof Error ? err.message.slice(0, 60) : '异常';
    out.ms = Date.now() - started;
    return out;
  }
}
