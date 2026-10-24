import { describe, expect, it } from 'vitest';
import { isPinyinQuery, matchesPinyin, pinyinInitials } from './pinyin';

describe('pinyinInitials（片名 → 拼音首字母）', () => {
  it('常见片名转首字母', () => {
    expect(pinyinInitials('奇妙萌可')).toBe('qmmk');
    expect(pinyinInitials('斗破苍穹年番')).toBe('dpcqnf');
    expect(pinyinInitials('西游记')).toBe('xyj');
    expect(pinyinInitials('凡人修仙传')).toBe('frxxc'); // 传 chuán
  });

  it('副标题、数字、英文都保留可用信息', () => {
    // 副标题只贡献首字母，不阻断主标题的前缀
    expect(pinyinInitials('奇妙萌可 第二季')).toBe('qmmkdej');
    expect(pinyinInitials('CCTV-1 综合频道')).toBe('cctv1zhpd');
    expect(pinyinInitials('12怒汉')).toBe('12nh');
  });

  it('标点与空白不产生噪声', () => {
    expect(pinyinInitials('大展宏图（2026）')).toBe('dzht2026'); // 数字保留，便于 qmmk2 命中第二季
    expect(pinyinInitials(' 沙丘  ')).toBe('sq');
  });

  it('非汉字文本退化为小写字母数字', () => {
    expect(pinyinInitials('Discovery')).toBe('discovery');
    expect(pinyinInitials('')).toBe('');
  });
});

describe('isPinyinQuery（什么样的输入按拼音处理）', () => {
  it('纯字母至少两位才算拼音', () => {
    expect(isPinyinQuery('qmmk')).toBe(true);
    expect(isPinyinQuery('QMMK')).toBe(true);
    expect(isPinyinQuery('q')).toBe(false);
    expect(isPinyinQuery('沙丘')).toBe(false);
    expect(isPinyinQuery('沙丘 2')).toBe(false);
    expect(isPinyinQuery('cctv1')).toBe(false);
  });
});

describe('matchesPinyin（首字母命中片名）', () => {
  it('前缀命中', () => {
    expect(matchesPinyin('奇妙萌可', 'qmmk')).toBe(true);
    expect(matchesPinyin('奇妙萌可之闪耀流星', 'qmmk')).toBe(true);
  });

  it('隔着副标题也能命中', () => {
    // qmmkzsyxl → 允许 q、m、m、k 依次出现即可
    expect(matchesPinyin('奇妙萌可之闪耀流星', 'qmmk')).toBe(true);
    expect(matchesPinyin('奇妙萌可之闪耀流星', 'qmx')).toBe(false);
  });

  it('顺序不对不算命中', () => {
    expect(matchesPinyin('奇妙萌可', 'kmmq')).toBe(false);
    expect(matchesPinyin('沙丘', 'qmmk')).toBe(false);
  });

  it('空查询与空片名都返回 false', () => {
    expect(matchesPinyin('奇妙萌可', '')).toBe(false);
    expect(matchesPinyin('', 'qmmk')).toBe(false);
    expect(matchesPinyin('***', 'qmmk')).toBe(false);
  });
});
