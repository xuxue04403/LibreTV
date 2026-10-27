/**
 * 批量检测订阅地址：能否下载 → 能否解析出 Apple CMS 点播源 → 源是否真的能搜出结果。
 *
 * 用法：
 *   npx vite-node tools/audit/sub-scan.ts            # 全量
 *   npx vite-node tools/audit/sub-scan.ts 饭太硬      # 只跑名字/分组包含关键字的
 *
 * 背景：用户给的「接口」一大半是**导航页**（HTML），真正的 TVBox JSON 藏在页面链接里。
 * 所以这里遇到 HTML 会先抽出页面里的候选 JSON/M3U 链接，逐个试。
 *
 * 输出：
 *   [OK]   至少一个 CMS 源真能搜出结果
 *   [WEAK] 能解析但没有可用 CMS 源（多为 spider 源，客户端版用不了）
 *   [DEAD] 下载/解析全部失败
 */

import { cmsRequestHeaders, parseSearchList } from '../../packages/core/src/cms';
import { createFetchHttp } from '../../packages/core/src/http';
import { parseRelaxedJson, normalizeSubscription } from '../../packages/core/src/subscriptions';
import type { SourceConfig } from '../../packages/core/src/types';

const KEYWORD = '我';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface Entry {
  group: string;
  name: string;
  url: string;
}

const ENTRIES: Entry[] = [
  { group: '饭太硬', name: '饭太硬.cc', url: 'http://www.饭太硬.cc/tv' },
  { group: '饭太硬', name: '饭太硬.net', url: 'http://www.饭太硬.net/tv' },
  { group: '饭太硬', name: 'fty.xxooo.cf', url: 'http://fty.xxooo.cf/tv' },
  { group: '饭太硬', name: '饭太硬.art', url: 'http://www.饭太硬.art/tv' },
  { group: '饭太硬', name: 'fty.888484.xyz', url: 'http://fty.888484.xyz/tv' },
  { group: '饭太硬', name: 'fty.333232.xyz', url: 'http://fty.333232.xyz/tv' },

  { group: '肥猫', name: '肥猫.net', url: 'http://肥猫.net/' },
  { group: '肥猫', name: 'hello.肥猫.net', url: 'http://hello.肥猫.net' },
  { group: '肥猫', name: '肥猫.net/tv', url: 'http://肥猫.net/tv' },
  { group: '肥猫', name: '9877.kstore.space', url: 'https://9877.kstore.space/ONE/one.json' },
  { group: '肥猫', name: '肥猫.com', url: 'http://肥猫.com' },

  { group: '摸鱼', name: '我不是.摸鱼儿.top', url: 'http://我不是.摸鱼儿.top' },
  { group: '摸鱼', name: 'www.小不点.com', url: 'http://www.小不点.com' },

  { group: '王二小', name: '9280.vip/newwex', url: 'https://9280.kstore.vip/newwex.json' },
  { group: '王二小', name: 'tvbox.王二小.top', url: 'http://tvbox.王二小放牛娃.top' },
  { group: '王二小', name: 'tv.999888987.xyz', url: 'http://tv.999888987.xyz/' },
  { group: '王二小', name: 'tv.999888123.xyz', url: 'http://tv.999888123.xyz/' },
  { group: '王二小', name: '9280.vip/wex', url: 'https://9280.kstore.vip/wex.json' },
  { group: '王二小', name: 'iyouhun.com/tv/wex', url: 'https://www.iyouhun.com/tv/wex' },
  { group: '王二小', name: 'tvbox.punycode.top', url: 'http://tvbox.xn--4kq62z5rby2qupq9ub.top' },

  { group: '欧歌', name: 'nxog.id=3', url: 'https://xn--sdds-rp5imh.v.nxog.top/apitv.php?id=3' },
  { group: '欧歌', name: 'dkw/apib id=2', url: 'https://xn--54qz74d.u.xn--dkw.xn--6qq986b3xl/apib.php?id=2' },
  { group: '欧歌', name: 'i8sz35d1yr id=3', url: 'https://xn--i8sz35d1yr.u.nxog.top/apib.php?id=3' },
  { group: '欧歌', name: 'z7x900a id=4', url: 'https://xn--z7x900a.e.nxog.top/apib.php?id=4' },

  { group: '凯速', name: '6800.kstore.vip', url: 'https://6800.kstore.vip/fish.json' },
  { group: '小盒子4K', name: 'xhztv.top', url: 'http://xhztv.top/4k.json' },
  { group: '二月红', name: 'vicp.fun/eggp', url: 'https://700sjro44343.vicp.fun/eggp/0211/tv.json' },
  { group: '菜妮丝', name: 'tv.菜妮丝.top', url: 'https://tv.菜妮丝.top' },
  { group: '宝盒', name: '宝盒接口.top', url: 'https://宝盒接口.top' },
  { group: '潇洒', name: 'qist.wyfc.qzz.io', url: 'https://qist.wyfc.qzz.io/xiaosa/api.json' },
  { group: '苍蓝', name: 'xn--6orr3pi6g9uu.top', url: 'http://xn--6orr3pi6g9uu.top' },
  { group: 'catbox', name: 'catbox.n13.club', url: 'https://catbox.n13.club/jk/t4.json' },
  { group: '影视仓', name: '影视仓.com', url: 'http://影视仓.com/' },
  { group: 'UUCCC', name: 'xn--5mqx81b535a.com', url: 'http://xn--5mqx81b535a.com' },
  { group: '日后', name: 'rihou.cc:555', url: 'http://rihou.cc:555/nzk/nzk0722.json' },
  { group: '真心', name: 'cnb.cool/FongMi', url: 'https://cnb.cool/fish2018/zx/-/git/raw/master/FongMi.json' },
  { group: '传说', name: 'chuanshuo.77blog.cn', url: 'https://chuanshuo.77blog.cn/tv.json' },
  { group: '蓝天', name: 'gitee lukei7', url: 'https://gitee.com/lukei7/lib/raw/Luck/%E8%87%AA%E5%BB%BA.json' },
  { group: '毒盒', name: 'xn--8owq8u.com/tv', url: 'https://xn--8owq8u.com/tv/' },
  { group: '小马', name: 'szyyds.cn', url: 'https://szyyds.cn/tv/x.json' },
  { group: '蜗牛', name: 'tv.蜗牛.top', url: 'https://tv.xn--11x555b.top/svip' },
  { group: '朱雀', name: 'gitee yiwu369', url: 'https://gitee.com/yiwu369/6758/raw/master/朱雀/api.json' },
  { group: '动漫', name: 'yingm.cc/dm', url: 'https://www.yingm.cc/dm/dm.json' },
  { group: '茄子', name: 'vicp.fun/qzku', url: 'https://700sjro44343.vicp.fun/eggp/qzku/tv.json' },
  { group: '小米', name: 'miqk.cc', url: 'http://miqk.cc/小米/DEMO.json' },
  { group: 'vox', name: 'onedev.io/vox', url: 'https://code.onedev.io/vox/~raw/master/demo.json' },
  { group: 'L佬', name: 'lushunming.qzz.io', url: 'https://android.lushunming.qzz.io/json/index.json' },
  { group: '分享', name: 'hucongrong.web3v.work', url: 'http://hucongrong.web3v.work/风水/fxz/fxz.json' },
  { group: '喵影', name: 'bitbucket/xpg', url: 'https://bitbucket.org/xduo/duoapi/raw/master/xpg.json' },
  { group: '脑斧', name: '6492.kstore.space', url: 'https://6492.kstore.space/xnf/xnf.json' },
  { group: '心魔', name: 'fastgit yw88075', url: 'https://fastgit.cc/https://raw.githubusercontent.com/yw88075/tvbox/main/yw.json' },
  { group: '雷蒙', name: 'fastgit N3RD', url: 'https://fastgit.cc/https://raw.githubusercontent.com/n3rddd/N3RD/master/JN/lemj.json' },
  { group: '道长', name: 'gitlab duomv', url: 'https://gitlab.com/duomv/dzhipy/-/raw/main/index.json' },
  { group: '俊佬', name: 'jundie.top:81', url: 'http://home.jundie.top:81/top98.json' },
];

const http = createFetchHttp();

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string; ct: string }> {
  try {
    const res = await http.request(url, { timeoutMs: 20_000, headers: { 'User-Agent': UA } });
    return { ok: res.ok, status: res.status, text: res.text, ct: String(res.headers['content-type'] ?? '') };
  } catch (err) {
    return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err), ct: '' };
  }
}

/** 从 HTML 导航页里抽可能的订阅链接（.json / .txt / 已知的配置托管） */
function extractCandidates(html: string, baseUrl: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>()\\]+/g)) {
    const raw = m[0].replace(/&amp;/g, '&');
    if (/\.(json|txt)(\?|$)/i.test(raw) || /kstore\.(vip|space)|raw\.githubusercontent|gitlink|jsdelivr/i.test(raw)) {
      if (!/\.(png|jpe?g|gif|webp|svg|ico|css|js)(\?|$)/i.test(raw)) found.add(raw);
    }
  }
  // 相对链接补全
  for (const m of html.matchAll(/href="([^"]+\.(?:json|txt))"/gi)) {
    try {
      found.add(new URL(m[1], baseUrl).toString());
    } catch {
      /* 忽略非法链接 */
    }
  }
  return [...found];
}

interface ProbeOutcome {
  ok: boolean;
  count: number;
  err?: string;
  ms: number;
}

async function probeSource(source: SourceConfig): Promise<ProbeOutcome> {
  const started = Date.now();
  const url = `${source.url.replace(/\/+$/, '')}?ac=videolist&wd=${encodeURIComponent(KEYWORD)}&pg=1`;
  try {
    const res = await http.request(url, { timeoutMs: 12_000, headers: cmsRequestHeaders() });
    if (!res.ok) return { ok: false, count: 0, err: `HTTP ${res.status}`, ms: Date.now() - started };
    if (!res.text.trim().startsWith('{')) {
      return { ok: false, count: 0, err: `非 JSON：${res.text.slice(0, 20)}`, ms: Date.now() - started };
    }
    const items = parseSearchList(JSON.parse(res.text), source);
    return { ok: items.length > 0, count: items.length, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, count: 0, err: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

interface Resolved {
  origin: string;
  sources: SourceConfig[];
  liveCount: number;
  note: string;
}

/** 把一条用户给的地址解析成若干 CMS 源：本身是 JSON 就直接用，是 HTML 就挖里面的订阅 */
async function resolveEntry(entry: Entry): Promise<{ resolved: Resolved[]; errors: string[] }> {
  const errors: string[] = [];
  const first = await fetchText(entry.url);
  if (!first.ok) {
    errors.push(first.status ? `HTTP ${first.status}` : first.text.slice(0, 60));
    return { resolved: [], errors };
  }

  const looksHtml = /html/i.test(first.ct) || /^\s*<(!doctype|html)/i.test(first.text);
  const targets: string[] = [];
  if (!looksHtml) {
    targets.push(entry.url);
  } else {
    const found = extractCandidates(first.text, entry.url);
    if (found.length === 0) errors.push(`HTML 导航页里没找到订阅链接（${first.text.length} 字节）`);
    targets.push(...found.slice(0, 6));
  }

  const resolved: Resolved[] = [];
  for (const target of targets) {
    const res = target === entry.url ? first : await fetchText(target);
    if (!res.ok) {
      errors.push(`${target} → ${res.status ? `HTTP ${res.status}` : res.text.slice(0, 40)}`);
      continue;
    }
    if (/^\s*<(!doctype|html)/i.test(res.text) || /html/i.test(res.ct)) {
      errors.push(`${target} → 仍是 HTML`);
      continue;
    }
    try {
      const parsed = normalizeSubscription(parseRelaxedJson(res.text), target);
      resolved.push({
        origin: target,
        sources: parsed.sources,
        liveCount: parsed.liveSources.length,
        note: `${parsed.stats.format} 跳过=${parsed.stats.skipped}(${JSON.stringify(parsed.stats.skippedByReason)})`,
      });
    } catch (err) {
      errors.push(`${target} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { resolved, errors };
}

async function main() {
  const filter = process.argv[2];
  const list = filter
    ? ENTRIES.filter((e) => e.group.includes(filter) || e.name.includes(filter) || e.url.includes(filter))
    : ENTRIES;

  console.log(`共 ${list.length} 个接口待检测，搜索关键词「${KEYWORD}」\n`);

  const summary: Array<{
    group: string;
    name: string;
    status: 'OK' | 'WEAK' | 'DEAD';
    alive: Array<{ listName: string; source: SourceConfig; count: number; ms: number }>;
    detail: string;
  }> = [];

  for (const entry of list) {
    const { resolved, errors } = await resolveEntry(entry);

    if (resolved.length === 0) {
      const detail = errors.slice(0, 2).join('；') || '无可用订阅';
      console.log(`[DEAD] ${entry.group} / ${entry.name}  ${detail}`);
      summary.push({ group: entry.group, name: entry.name, status: 'DEAD', alive: [], detail });
      continue;
    }

    const alive: Array<{ listName: string; source: SourceConfig; count: number; ms: number }> = [];
    let cmsTotal = 0;
    let liveTotal = 0;
    for (const r of resolved) {
      cmsTotal += r.sources.length;
      liveTotal += r.liveCount;
      for (const source of r.sources.slice(0, 12)) {
        const p = await probeSource(source);
        if (p.ok) alive.push({ listName: r.origin, source, count: p.count, ms: p.ms });
      }
    }

    const status = alive.length > 0 ? 'OK' : 'WEAK';
    const detail =
      status === 'OK'
        ? `${resolved.length} 份订阅 / ${cmsTotal} 个 CMS 源，${alive.length} 个可用`
        : `${resolved.length} 份订阅 / ${cmsTotal} 个 CMS 源，全部搜不出结果（直播 ${liveTotal}）`;
    console.log(`[${status}] ${entry.group} / ${entry.name}  ${detail}`);
    for (const a of alive) console.log(`         ✓ ${a.source.name}  ${a.count} 条 / ${a.ms}ms  ${a.source.url}`);
    summary.push({ group: entry.group, name: entry.name, status, alive, detail });
  }

  console.log('\n================ 汇总 ================');
  const okList = summary.filter((r) => r.status === 'OK');
  console.log(
    `OK ${okList.length} / WEAK ${summary.filter((r) => r.status === 'WEAK').length} / DEAD ${summary.filter((r) => r.status === 'DEAD').length}`
  );

  console.log('\n---- 可用接口（按可用源数排序）----');
  for (const r of okList.sort((a, b) => b.alive.length - a.alive.length)) {
    console.log(`${String(r.alive.length).padStart(2)} 源  ${r.group} / ${r.name}`);
  }

  console.log('\n---- 所有可用的 CMS 源地址（去重，可直接加进软件）----');
  const uniq = new Map<string, { name: string; count: number; ms: number; from: string }>();
  for (const r of okList) {
    for (const a of r.alive) {
      const prev = uniq.get(a.source.url);
      if (!prev || a.count > prev.count) {
        uniq.set(a.source.url, { name: a.source.name, count: a.count, ms: a.ms, from: `${r.group}/${r.name}` });
      }
    }
  }
  for (const [url, info] of [...uniq.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`${info.name}\t${url}\t${info.count}条 ${info.ms}ms\t来自 ${info.from}`);
  }
}

void main();
