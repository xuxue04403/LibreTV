/**
 * 从公开维护的 TVBox / 影视仓配置里抽取「标准苹果 CMS 采集接口」候选。
 *
 * 做法：直接对配置原文做 URL 正则抓取，再按 CMS 采集路径过滤。
 * 比结构解析更稳——各家配置格式（TVBox json / YAML / 多仓指针 / Fongmi 兼容）差异太大。
 *
 * 用法：node tools/audit/collect-candidates.mjs [out.json]
 */

import { writeFileSync } from 'node:fs';

/** 公开维护、更新频繁的配置地址（多给几个，某个挂了不影响整体） */
const CONFIGS = [
  // TVbox.org 官方汇总（sources.yaml + dist）
  'https://raw.githubusercontent.com/TVboxorg/TVbox/main/sources.yaml',
  'https://raw.githubusercontent.com/TVboxorg/TVbox/main/dist/tvbox.json',
  'https://raw.githubusercontent.com/TVboxorg/TVbox/main/dist/index.json',
  // 个人聚合仓
  'https://raw.githubusercontent.com/YiMing918/ym-tvbox/main/peter_tvbox_pro.json',
  // cluntop 多套配置
  'https://raw.githubusercontent.com/cluntop/tvbox/main/box.json',
  'https://raw.githubusercontent.com/cluntop/tvbox/main/fun.json',
  'https://raw.githubusercontent.com/cluntop/tvbox/main/aa.json',
  'https://raw.githubusercontent.com/cluntop/tvbox/main/jsm.json',
  // 其他
  'https://raw.githubusercontent.com/fengzhiku123/ysc-api/main/sources.json',
  'https://raw.githubusercontent.com/fengzhiku123/ysc-api/main/fongmi.json',
  'https://raw.githubusercontent.com/fengzhiku123/ysc-api/main/tvbox.json',
  'https://raw.githubusercontent.com/hjwp2026-cmd/self-tvbox/main/state.json',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 标准苹果 CMS 采集接口的路径特征（我们这端只支持这种纯 HTTP JSON 采集站） */
const CMS_RE = /https?:\/\/[^\s"'\\,<>()\][]+?\/(?:api\.php\/provide\/vod|provide\/vod)\/?/gi;

/** 明显不是采集站的关键词，先排掉，省得后面白测 */
const DENY = /(\.js|\.jar|\.apk|\.png|\.jpg|\.css|\.html|github\.com|jsdelivr\.net\/gh\/[^/]+\/[^/]+\/jar)/i;

async function grab(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return { url, ok: false, note: `HTTP ${res.status}` };
    return { url, ok: true, text: await res.text() };
  } catch (err) {
    return { url, ok: false, note: String(err?.message ?? err).slice(0, 60) };
  }
}

/** 从站点名里剥掉「资源/影视/采集」等噪声，便于人工比对 */
function cleanName(raw) {
  return raw
    .replace(/[\u4e00-\u9fa5]{0,2}(资源|影视|采集|影视资源|视频|在线|网|站|CMS|API)+$/i, '')
    .replace(/[|｜\-—_]+.*$/, '')
    .trim();
}

const seen = new Map();

for (const url of CONFIGS) {
  const res = await grab(url);
  if (!res.ok) {
    console.log(`✗ ${url}  ${res.note}`);
    continue;
  }
  const matches = [...res.text.matchAll(CMS_RE)].map((m) => m[0].replace(/\/+$/, ''));
  const uniq = [...new Set(matches)];
  let added = 0;
  for (const raw of uniq) {
    if (DENY.test(raw)) continue;
    let host = '';
    try {
      host = new URL(raw).hostname;
    } catch {
      continue;
    }
    if (seen.has(raw)) {
      seen.get(raw).seenOn += 1;
      continue;
    }
    // 名字：在原文里找到这个 URL 前面的 "name": "xxx"
    const idx = res.text.indexOf(raw);
    const before = idx > 0 ? res.text.slice(Math.max(0, idx - 300), idx) : '';
    const nameMatch = [...before.matchAll(/"name"\s*:\s*"([^"]{1,40})"/g)].pop();
    const name = nameMatch ? cleanName(nameMatch[1]) || host : host;
    seen.set(raw, { name, url: raw, host, seenOn: 1, from: url });
    added += 1;
  }
  console.log(`✓ ${url}  命中 ${uniq.length}，新增 ${added}`);
}

const all = [...seen.values()].sort((a, b) => b.seenOn - a.seenOn);
console.log(`\n去重后共 ${all.length} 个候选采集接口`);
for (const item of all.slice(0, 60)) {
  console.log(`  ${String(item.seenOn).padStart(2)}× ${item.name.padEnd(14)} ${item.url}`);
}

const out = process.argv[2] ?? '.tmp-upstream/candidates.json';
writeFileSync(
  out,
  JSON.stringify(
    all.map((item, i) => ({ name: item.name || `候选${i}`, url: item.url })),
    null,
    2
  )
);
console.log(`\n已写入 ${out}`);
