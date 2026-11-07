/**
 * 生成「汉字 → 拼音首字母」查表。
 *
 * TV 用遥控器打字非常痛苦，让用户输 `qmmk` 就能搜到「奇妙萌可」很实用。
 * 但采集站的接口只支持 `LIKE '%中文%'`，拼音检索只能在本地做，本地就必须有一张表。
 *
 * 表的形态：从 U+4E00 起连续 20992 个码位，每个码位一个字符（a-z 或 `?`）。
 * 直接用一个字符串存，查询是一次 `charCodeAt` 减法 + 一次下标，比 Map 省内存也更快。
 * 两端共用同一份数据：TS 侧生成到 `packages/core/src/pinyin-table.ts`，
 * Kotlin 侧写到 `apps/androidtv/app/src/main/assets/pinyin-table.txt`。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const START = 0x4e00;
const END = 0x9fff;

const chars = [];
for (let cp = START; cp <= END; cp += 1) chars.push(String.fromCodePoint(cp));

// 一次性批量取首字母：逐个调用要两万次，慢一个数量级
const parts = pinyin(chars.join(''), { pattern: 'first', type: 'array', toneType: 'none' });
if (parts.length !== chars.length) {
  throw new Error(`pinyin-pro 返回长度不符：${parts.length} != ${chars.length}`);
}

let table = '';
for (const part of parts) {
  const first = (part || '')[0] || '';
  table += /^[a-z]$/.test(first) ? first : '?';
}

const tsPath = resolve(ROOT, 'packages/core/src/pinyin-table.ts');
writeFileSync(
  tsPath,
  `/**
 * 汉字 → 拼音首字母查表（自动生成，勿手改）。
 *
 * 覆盖 U+${START.toString(16).toUpperCase()}..U+${END.toString(16).toUpperCase()} 共 ${table.length} 个码位，
 * 每位的字符就是该字的拼音首字母；没有拼音（或非汉字）记作 \`?\`。
 * 生成脚本：\`tools/gen-pinyin-table.mjs\`（依赖 pinyin-pro）。
 */
export const PINYIN_TABLE_START = 0x${START.toString(16)};
export const PINYIN_TABLE = '${table}';
`,
  'utf8'
);

const assetPath = resolve(ROOT, 'apps/androidtv/app/src/main/assets/pinyin-table.txt');
mkdirSync(dirname(assetPath), { recursive: true });
writeFileSync(assetPath, table, 'utf8');

// 多音字备选首字母：`重` 主表只给 z（zhòng），但片名里「重庆」读 chóng，
// 只认主表时用户输 cq 永远搜不到。pinyin-pro 的 multiple 能给出全部读音，
// 这里只保留与主表不同的首字母，做成 `字:字母` 一行一个的小表（约 2000 行）。
const alts = [];
for (const ch of chars) {
  const readings = pinyin(ch, { multiple: true, toneType: 'none', type: 'array' });
  const letters = [...new Set(readings.map((r) => (r || '')[0]).filter((c) => c >= 'a' && c <= 'z'))];
  if (letters.length <= 1) continue;
  const primary = table[ch.codePointAt(0) - START];
  const extra = letters.filter((c) => c !== primary);
  if (extra.length > 0) alts.push(`${ch}:${extra.join('')}`);
}
const altPath = resolve(ROOT, 'apps/androidtv/app/src/main/assets/pinyin-alts.txt');
writeFileSync(altPath, alts.join('\n') + '\n', 'utf8');

console.log(`表格长度 ${table.length}，多音字 ${alts.length} 个，已写入：`);
console.log(`  ${tsPath}`);
console.log(`  ${assetPath}`);
console.log(`  ${altPath}`);
