/**
 * 对「能解析出 CMS 源但搜索无结果」的订阅做逐源诊断：
 * 打印每个源的完整错误、原始响应片段，判断到底是源死了还是我们请求方式不对。
 *
 * 用法：npx vite-node tools/audit/sub-diag.ts <订阅地址>
 */

import { createFetchHttp } from '../../packages/core/src/http';
import { parseRelaxedJson, normalizeSubscription } from '../../packages/core/src/subscriptions';

const http = createFetchHttp();
const url = process.argv[2];
if (!url) {
  console.error('用法：npx vite-node tools/audit/sub-diag.ts <订阅地址>');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function main() {
  const sub = await http.request(url, { timeoutMs: 20_000, headers: { 'User-Agent': UA } });
  console.log(`订阅 HTTP ${sub.status}，${sub.text.length} 字节`);

  const parsed = normalizeSubscription(parseRelaxedJson(sub.text), url);
  console.log(`格式=${parsed.stats.format} CMS=${parsed.sources.length} 直播=${parsed.liveSources.length}`);
  console.log(`跳过统计：${JSON.stringify(parsed.stats.skippedByReason)}`);
  if (parsed.stats.skippedSamples?.length) console.log(`跳过样本：${parsed.stats.skippedSamples.join(' | ')}`);

  for (const source of parsed.sources.slice(0, 12)) {
    const target = `${source.url}?ac=videolist&wd=${encodeURIComponent('我')}&pg=1`;
    process.stdout.write(`\n── ${source.name}  ${source.url}\n`);
    try {
      const res = await http.request(target, { timeoutMs: 15_000, headers: { 'User-Agent': UA } });
      const head = res.text.slice(0, 160).replace(/\s+/g, ' ');
      console.log(`   请求 ${source.url}?ac=videolist&wd=我 → HTTP ${res.status}  ${res.text.length} 字节`);
      console.log(`   响应头 ${head}`);
      try {
        const data = JSON.parse(res.text) as Record<string, unknown>;
        const list = (data.list ?? []) as unknown[];
        console.log(`   JSON 可解析：code=${String(data.code)} msg=${String(data.msg ?? '')} list=${Array.isArray(list) ? list.length : '非数组'}`);
        if (Array.isArray(list) && list.length > 0) {
          const first = list[0] as Record<string, unknown>;
          console.log(`   首条字段：${Object.keys(first).join(', ')}`);
          console.log(`   首条：name=${String(first.vod_name)} type=${String(first.type_name)}`);
        }
        // 顺带看看分类表
        const cat = await http.request(`${source.url}?ac=list&pg=1`, { timeoutMs: 15_000, headers: { 'User-Agent': UA } });
        const catData = JSON.parse(cat.text) as Record<string, unknown>;
        const classes = (catData.class ?? []) as Array<Record<string, unknown>>;
        console.log(`   分类表 HTTP ${cat.status}：${Array.isArray(classes) ? classes.length : '非数组'} 个，前几个：${classes.slice(0, 5).map((c) => `${String(c.type_id)}=${String(c.type_name)}`).join(' ')}`);
      } catch (err) {
        console.log(`   非 JSON：${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      console.log(`   请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

void main();
