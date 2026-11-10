/**
 * 直播源体检：下载耗时 → 频道数 → 分组 → 抽样真播（拿到分片才算通）→ 分辨率统计。
 *
 * 直播和点播的「可用」判定不同：
 * - 频道列表能下载 ≠ 能播（绝大多数源站列表都在，但台是死的）；
 * - m3u8 能打开 ≠ 能播（很多是 master 之后 403，或分片 403）；
 * - 所以必须一路拉到分片字节，并且能读到分辨率才算真可用。
 *
 * 用法：
 *   npx vite-node tools/audit/live-health.ts                 # 体检 defaults/sources.json
 *   npx vite-node tools/audit/live-health.ts -- --file x.json --sample 60
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createFetchHttp } from '../../packages/core/src/http';
import { fetchLivePlaylist } from '../../packages/core/src/live';
import type { HttpClient } from '../../packages/core/src/http';
import { BROWSER_UA } from './hls';

const http: HttpClient = createFetchHttp();

export interface ChannelProbe {
  name: string;
  group: string;
  ok: boolean;
  /** 从开始到拿到第一个分片首字节的毫秒数 */
  ms: number;
  /** 有分辨率说明是视频流；0 表示没解析到（可能是纯音频/加密流） */
  width: number;
  height: number;
  note: string;
}

export interface LiveReport {
  name: string;
  url: string;
  /** 播放列表下载字节数与耗时 */
  bytes: number;
  loadMs: number;
  channels: number;
  groups: number;
  sampled: number;
  alive: number;
  /** 能读到分辨率的频道数（真正验证是视频流） */
  withResolution: number;
  /** 1080p 及以上 */
  hd: number;
  latencyMedian: number;
  error?: string;
  probes: ChannelProbe[];
}

/** 从 m3u8 里找分辨率：直接列表看 EXT-X-STREAM-INF 的 RESOLUTION，分片看 TS 的 PMT 太贵，用 master 声明值 */
function pickResolution(text: string): { width: number; height: number } {
  const matches = [...text.matchAll(/RESOLUTION=(\d+)x(\d+)/g)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
  }));
  if (matches.length === 0) return { width: 0, height: 0 };
  // master 里有多个码率时取最高
  return matches.sort((a, b) => b.height - a.height)[0];
}

/** 探测一个直播频道：列表 → 变体 → 分片首字节 */
async function probeChannel(channel: { name: string; url: string; group?: string }): Promise<ChannelProbe> {
  const started = Date.now();
  const out: ChannelProbe = {
    name: channel.name,
    group: channel.group ?? '',
    ok: false,
    ms: 0,
    width: 0,
    height: 0,
    note: '',
  };
  const headers = { 'User-Agent': BROWSER_UA };

  try {
    let url = channel.url;
    const res = await http.request(url, { timeoutMs: 9_000, headers });
    if (!res.ok) {
      Object.assign(out, { ms: Date.now() - started, note: `HTTP ${res.status}` });
      return out;
    }
    if (!res.text.includes('#EXTM3U')) {
      Object.assign(out, { ms: Date.now() - started, note: `非 m3u8（${res.bytes.byteLength}B）` });
      return out;
    }
    let body = res.text;
    // RESOLUTION 只写在 master 的 EXT-X-STREAM-INF 上，跟到变体列表后就没了，
    // 所以必须在跟随之前先记下来。
    let reso = pickResolution(body);
    // 最多跟 2 层 master
    for (let depth = 0; depth < 2 && body.includes('#EXT-X-STREAM-INF'); depth += 1) {
      const variantLine = body
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      if (!variantLine) break;
      const next = new URL(variantLine, url).toString();
      const sub = await http.request(next, { timeoutMs: 9_000, headers });
      if (!sub.ok) {
        Object.assign(out, { ms: Date.now() - started, note: `变体 HTTP ${sub.status}` });
        return out;
      }
      url = next;
      body = sub.text;
      const deeper = pickResolution(body);
      if (deeper.height > reso.height) reso = deeper;
    }
    out.width = reso.width;
    out.height = reso.height;

    const seg = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!seg) {
      Object.assign(out, { ms: Date.now() - started, note: '列表无分片' });
      return out;
    }
    const segUrl = new URL(seg, url).toString();
    const piece = await http.request(segUrl, { timeoutMs: 9_000, headers });
    const firstByteAt = Date.now() - started;
    if (!piece.ok) {
      Object.assign(out, { ms: firstByteAt, note: `分片 HTTP ${piece.status}` });
      return out;
    }
    const b = piece.bytes;
    const isTs = b[0] === 0x47;
    const isFmp4 = b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
    const ct = piece.headers['content-type'] ?? '';
    if (/text\/html/i.test(ct) || b.byteLength < 200) {
      Object.assign(out, { ms: firstByteAt, note: `非视频（${ct.slice(0, 20)} ${b.byteLength}B）` });
      return out;
    }
    out.ok = isTs || isFmp4 || b.byteLength > 20_000;
    out.ms = firstByteAt;
    out.note = isTs ? 'TS' : isFmp4 ? 'fMP4' : `${b.byteLength}B`;
    return out;
  } catch (err) {
    Object.assign(out, {
      ms: Date.now() - started,
      note: err instanceof Error ? err.message.slice(0, 40) : '失败',
    });
    return out;
  }
}

/** 等距抽样：保证覆盖整张列表，而不是只看开头几个 */
function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
}

export async function checkLiveSource(
  source: { name: string; url: string },
  opts: { sample?: number; concurrency?: number } = {}
): Promise<LiveReport> {
  const sampleSize = opts.sample ?? 40;
  const concurrency = opts.concurrency ?? 12;
  const report: LiveReport = {
    name: source.name,
    url: source.url,
    bytes: 0,
    loadMs: 0,
    channels: 0,
    groups: 0,
    sampled: 0,
    alive: 0,
    withResolution: 0,
    hd: 0,
    latencyMedian: 0,
    probes: [],
  };

  const started = Date.now();
  let playlist;
  try {
    playlist = await fetchLivePlaylist(source.url, http, { timeoutMs: 40_000 });
    report.loadMs = Date.now() - started;
    report.channels = playlist.channels.length;
    report.groups = playlist.groups.length;
    report.bytes = new TextEncoder().encode(playlist.channels.map((c) => c.url).join('')).length;
  } catch (err) {
    report.error = err instanceof Error ? err.message.slice(0, 80) : '加载失败';
    return report;
  }

  const sample = spread(playlist.channels, sampleSize);
  report.sampled = sample.length;

  const probes: ChannelProbe[] = new Array(sample.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, sample.length) }, async () => {
      while (next < sample.length) {
        const i = next++;
        probes[i] = await probeChannel(sample[i]);
      }
    })
  );
  report.probes = probes;
  report.alive = probes.filter((p) => p.ok).length;
  report.withResolution = probes.filter((p) => p.ok && p.height > 0).length;
  report.hd = probes.filter((p) => p.ok && p.height >= 1080).length;
  const latencies = probes.filter((p) => p.ok).map((p) => p.ms).sort((a, b) => a - b);
  report.latencyMedian = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const atFile = args.indexOf('--file');
  const file = atFile >= 0 ? args[atFile + 1] : 'defaults/sources.json';
  const atSample = args.indexOf('--sample');
  const sample = atSample >= 0 ? Number(args[atSample + 1]) : 40;
  const atJson = args.indexOf('--json');
  const jsonOut = atJson >= 0 ? args[atJson + 1] : undefined;

  const raw = JSON.parse(readFileSync(file, 'utf8')) as { liveSources?: { name: string; url: string }[] };
  const sources = raw.liveSources ?? [];
  console.log(`体检 ${sources.length} 个直播源（每源抽 ${sample} 个频道）\n`);

  const reports: LiveReport[] = [];
  for (const source of sources) {
    const report = await checkLiveSource(source, { sample });
    reports.push(report);
    if (report.error) {
      console.log(`✗ ${report.name}  加载失败：${report.error}`);
      continue;
    }
    // 50% 为界：采集/上游抖动会让同一个源在 40%~75% 之间跳，60% 的线会把
    // 「能用但不太好」的源误判成坏源（实测 vbskycn 75%→73%、zhi35 60%→57%）。
    const rate = report.sampled > 0 ? Math.round((report.alive / report.sampled) * 100) : 0;
    console.log(
      `${rate >= 50 ? '✓' : '✗'} ${report.name.padEnd(16)} ${String(report.channels).padStart(5)}台/${String(
        report.groups
      ).padStart(3)}组 加载${String(report.loadMs).padStart(5)}ms  抽样${report.sampled} 可播${String(
        report.alive
      ).padStart(3)}(${rate}%) 分辨率${report.withResolution} 高清${report.hd} 首响中位${report.latencyMedian}ms`
    );
  }

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(reports, null, 2));
}

if (import.meta.url.replace(/\\/g, '/').endsWith('live-health.ts')) void main();
