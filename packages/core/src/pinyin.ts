import { PINYIN_TABLE, PINYIN_TABLE_START } from './pinyin-table';

/**
 * 取一个字符的拼音首字母；非汉字、生僻字、多音字都退化成空串。
 *
 * 首字母表是 `pinyin-pro` 批量生成的（见 `tools/gen-pinyin-table.mjs`），
 * 多音字取最常用读音——搜索场景下够用，猜错顶多多一条不匹配。
 */
function initialOf(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  const index = cp - PINYIN_TABLE_START;
  if (index < 0 || index >= PINYIN_TABLE.length) return '';
  const letter = PINYIN_TABLE[index];
  return letter === '?' ? '' : letter;
}

/**
 * 把片名转成「拼音首字母串」：`奇妙萌可` → `qmmk`。
 *
 * 规则：
 * - 汉字取首字母；
 * - 英文字母统一小写后原样保留（`CCTV-1` → `cctv1`）；
 * - 数字保留；
 * - 其余字符（空格、标点、`·`、全角符号）全部丢弃。
 *
 * 这样 `奇妙萌可 第二季` 与 `奇妙萌可2` 都会落到 `qmmk…`，用户输 `qmmk` 能同时命中。
 */
export function pinyinInitials(text: string): string {
  let out = '';
  for (const ch of text) {
    if (/[0-9]/.test(ch)) {
      out += ch;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      out += ch.toLowerCase();
      continue;
    }
    out += initialOf(ch);
  }
  return out;
}

/** 是否像「拼音首字母」查询：纯字母、至少两位（一位太容易误伤正常英文搜索） */
export function isPinyinQuery(query: string): boolean {
  return /^[a-z]{2,}$/i.test(query.trim());
}

/**
 * 判断片名是否匹配拼音首字母查询。
 *
 * 只认「连续命中」：`qmmk` 命中 `奇妙萌可`（前缀），也命中 `超能qmmk小队`（中段）。
 * 不做「跳字母」匹配——那样 `qmx` 会在 `qmmkzsyxl` 里被判定命中，噪声太大。
 */
export function matchesPinyin(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  const initials = pinyinInitials(name);
  if (!initials) return false;
  return initials.includes(needle);
}
