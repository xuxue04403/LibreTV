import { describe, expect, it } from 'vitest';
import {
  ADULT_KEYWORDS,
  ADULT_TITLE_KEYWORDS,
  filterAdultResults,
  isAdultContent,
} from './cms';

/**
 * 成人内容屏蔽的回归测试。
 *
 * 样本来自 2026-10 对 4 个内置采集源的真实抓取：
 * 关键词表里每一个词、以及"不该被拦"的误伤样本，都必须固定下来，
 * 否则后续调词表很容易把「福利院」这类正经内容一起杀掉。
 */
describe('isAdultContent：分类名', () => {
  it('命中成人分类名', () => {
    for (const type of ['伦理片', '福利片', '日本无码', '里番动漫', '韩国伦理', '国产传媒', 'SWAG', '91视频']) {
      expect(isAdultContent(type), type).toBe(true);
    }
  });

  it('正常分类名放行', () => {
    for (const type of ['电影片', '电视剧', '动漫片', '纪录片', '大陆综艺', '体育', '短剧', '电影解说']) {
      expect(isAdultContent(type), type).toBe(false);
    }
  });

  it('「福利」是关键词，但「福利院」这类正经分类不能被误伤', () => {
    // 真实数据里存在「福利院的阳光」这类家庭/公益题材
    expect(isAdultContent('福利片')).toBe(true);
    expect(isAdultContent('社会福利')).toBe(false);
    expect(isAdultContent('儿童福利')).toBe(false);
    expect(isAdultContent('福利院')).toBe(false);
  });

  it('空值与 undefined 安全', () => {
    expect(isAdultContent(undefined)).toBe(false);
    expect(isAdultContent('')).toBe(false);
  });
});

describe('isAdultContent：标题兜底（分类正常、片名露骨）', () => {
  it('拦住实测漏网的样本', () => {
    // 这些都是真实数据里分类名正常、但标题露骨的条目
    const cases: Array<[string, string]> = [
      ['爱情片', '我的23岁之无码青春'],
      ['电影解说', '情色片编年史[电影解说]'],
      ['剧情片', '三级片之王'],
      ['剧情片', '成人片合集'],
    ];
    for (const [type, name] of cases) {
      expect(isAdultContent(type, name), `${type}/${name}`).toBe(true);
    }
  });

  it('不误伤真实数据里的正经内容', () => {
    // 这些词（麻豆/黑料/星空/天美/果冻/蜜桃）在真实采集站里大量出现在正常内容中，
    // 刻意不纳入标题词表：宁可漏掉边界样本，也不能把儿童/家庭题材误杀
    const mustPass: Array<[string, string]> = [
      ['剧情片', '福利院的阳光'],
      ['台湾剧', '麻豆小镇'],
      ['短剧', '黑料局中局'],
      ['爱情片', '星空'],
      ['国产动漫', '吞噬星空'],
      ['日韩动漫', '果冻三剑客'],
      ['电影解说', '天降美食[电影解说]'],
      ['剧情片', '911事件'],
      ['日韩动漫', '91天'],
      ['剧情片', '愤怒的伦理学'],
      ['大陆综艺', '披荆斩棘2026'],
      // 2026-10 二轮实测：加了「情色/色情」之后，这些仍必须放行
      ['剧情片', '三级警戒'],
      ['电影解说', '连升三级[电影解说]'],
      ['剧情片', 'Sex and the City'],
      ['喜剧片', 'Zack and Miri make a porno'],
    ];
    for (const [type, name] of mustPass) {
      expect(isAdultContent(type, name), `${type}/${name}`).toBe(false);
    }
  });

  it('「情色/色情」必须能兜住正常分类下的成人片名', () => {
    // A/B 实测（adultFilter 开 vs 关）暴露的漏网样本：
    // 开启过滤后仍有 13 条，全部集中在「情色」这个词上
    const mustBlock: Array<[string, string]> = [
      ['剧情片', '水手服情色饲育'],
      ['喜剧片', '情色自白'],
      ['剧情片', '情色大亨'],
      ['剧情片', '情色自拍'],
      ['电影解说', '姐妹情色[电影解说]'],
      ['电影解说', '反情色[电影解说]'],
      ['日韩动漫', '情色漫画老师OVA'],
    ];
    for (const [type, name] of mustBlock) {
      expect(isAdultContent(type, name), `${type}/${name}`).toBe(true);
    }
  });
});

describe('isAdultContent：源级标记', () => {
  it('标记为成人源的条目无条件屏蔽', () => {
    // 订阅里的 isAdult 字段此前解析后就被丢弃，形同虚设
    expect(isAdultContent('电影片', '普通标题', true)).toBe(true);
    expect(isAdultContent(undefined, undefined, true)).toBe(true);
    expect(isAdultContent('电影片', '普通标题', false)).toBe(false);
  });
});

describe('filterAdultResults', () => {
  const items = [
    { name: '正常电影', typeName: '动作片' },
    { name: '伦理片标题', typeName: '伦理片' },
    { name: '我的23岁之无码青春', typeName: '爱情片' },
    { name: '福利院的阳光', typeName: '剧情片' },
    { name: '来自成人源', typeName: '剧情片', isAdult: true },
  ];

  it('开关打开时按分类 + 标题 + 源标记三重过滤', () => {
    const kept = filterAdultResults(items, true);
    expect(kept.map((i) => i.name)).toEqual(['正常电影', '福利院的阳光']);
  });

  it('开关关闭时原样返回', () => {
    expect(filterAdultResults(items, false)).toHaveLength(5);
  });

  it('缺少 typeName / name 的条目不会抛错', () => {
    expect(filterAdultResults([{ name: 'x' }, { typeName: 'y' }, {}], true)).toHaveLength(3);
  });
});

describe('关键词表自身的约束', () => {
  it('分类词表不含会大面积误伤的裸词', () => {
    // 「福利」是有意保留的（上游一致），靠 ADULT_TYPE_EXCEPTIONS 兜住误伤；
    // 但「片」「情」「色」这类单字绝不能进表
    for (const bad of ['片', '情', '色', '主播', '星空', '天美', '果冻', '麻豆', '黑料']) {
      expect(ADULT_KEYWORDS, bad).not.toContain(bad);
    }
  });

  it('标题词表不含高误伤词', () => {
    for (const bad of ['麻豆', '黑料', '星空', '天美', '果冻', '蜜桃', '福利']) {
      expect(ADULT_TITLE_KEYWORDS, bad).not.toContain(bad);
    }
  });

  it('词表无重复项', () => {
    expect(new Set(ADULT_KEYWORDS).size).toBe(ADULT_KEYWORDS.length);
    expect(new Set(ADULT_TITLE_KEYWORDS).size).toBe(ADULT_TITLE_KEYWORDS.length);
  });
});
