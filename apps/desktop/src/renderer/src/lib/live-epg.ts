import { currentAndNext, maybeGunzip, parseXmltv, type EpgProgram, type LiveEpg } from '@libretv/core';
import { http } from './bridge';

/**
 * 节目单（XMLTV）缓存。
 *
 * 为什么必须缓存且要缓存失败：一个 XMLTV 动辄几十 MB，而它包含**所有**频道的
 * 节目单。原来每次换台都重新下一次整份文件，换台越多越慢；而 iptv-org 的节目单
 * 超过主进程 16MB 的响应上限，注定失败——若不记住失败，每换一个台都要白等一遍。
 *
 * 因此：按 URL 缓存解析结果（含失败），10 分钟过期，同一 URL 只解析一次。
 */
const TTL_MS = 10 * 60 * 1000;

type ParsedEpg = Map<string, EpgProgram[]>;
type Entry = { at: number; ok: boolean; byChannel?: ParsedEpg };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

async function load(epgUrl: string, signal?: AbortSignal): Promise<Entry> {
  const hit = cache.get(epgUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;

  const pending = inflight.get(epgUrl);
  if (pending) return pending;

  const task = (async (): Promise<Entry> => {
    try {
      const res = await http.request(epgUrl, {
        headers: { Accept: 'application/xml, text/xml, application/gzip, */*' },
        timeoutMs: 20_000,
        signal,
      });
      if (!res.ok) return { at: Date.now(), ok: false };
      const bytes = await maybeGunzip(res.bytes);
      const text = new TextDecoder('utf-8').decode(bytes);
      return { at: Date.now(), ok: true, byChannel: parseXmltv(text) };
    } catch {
      return { at: Date.now(), ok: false };
    } finally {
      inflight.delete(epgUrl);
    }
  })();

  inflight.set(epgUrl, task);
  const entry = await task;
  cache.set(epgUrl, entry);
  return entry;
}

/**
 * 取某频道当前/下一档节目；任何失败都返回空结果，绝不抛错（节目单不该影响看直播）
 *
 * [signal] 用于「换台/退出播放页就取消」：一份 XMLTV 动辄几十 MB，
 * 用户在这个台上只待了两秒就换走，不取消的话请求会继续把整个文件下完。
 * 解析（parseXmltv）是同步的，取消只作用于网络阶段——即便如此，也能省掉
 * 后面那次几十 MB 的解码与正则扫描。
 */
export async function loadChannelEpg(
  epgUrl: string,
  channelId: string,
  signal?: AbortSignal
): Promise<LiveEpg> {
  const entry = await load(epgUrl, signal);
  const programs = entry.ok ? (entry.byChannel?.get(channelId) ?? []) : [];
  const { current, next } = currentAndNext(programs);
  return { channelId, current, next, programs };
}
