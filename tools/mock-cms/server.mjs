/**
 * 本地模拟 Apple CMS 采集站 —— 仅用于端到端联调与截图验证。
 *
 * 用法：
 *   node tools/mock-cms/server.mjs [端口]
 *   环境变量 MEDIA_DIR 指向包含 HLS 视频（index.m3u8 + seg*.ts）的目录。
 *
 * 行为对齐真实采集站：
 *   GET /api.php/provide/vod?ac=videolist&wd=<kw>&pg=1
 *   GET /api.php/provide/vod?ac=videolist&ids=<id>
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8099);
const MEDIA_DIR = process.env.MEDIA_DIR || join(process.cwd(), '.artifacts', 'hls');
const BASE = `http://127.0.0.1:${PORT}`;

const MOVIES = [
  {
    vod_id: 1,
    vod_name: '流浪地球',
    type_name: '科幻片',
    vod_year: '2019',
    vod_area: '中国大陆',
    vod_remarks: 'HD 中字',
    vod_pic: `${BASE}/img/1.svg`,
    vod_content: '太阳即将毁灭，人类在地球表面建造出巨大的推进器，寻找新的家园。',
  },
  {
    vod_id: 2,
    vod_name: '流浪地球 2',
    type_name: '科幻片',
    vod_year: '2023',
    vod_area: '中国大陆',
    vod_remarks: '蓝光 4K',
    vod_pic: `${BASE}/img/2.svg`,
    vod_content: '在人类面临末日之际，围绕太空电梯危机展开的故事。',
  },
  {
    vod_id: 3,
    vod_name: '繁花',
    type_name: '国产剧',
    vod_year: '2023',
    vod_area: '中国大陆',
    vod_remarks: '全 30 集',
    vod_pic: `${BASE}/img/3.svg`,
    vod_content: '九十年代的上海，阿宝在时代浪潮中起伏的人生。',
  },
];

const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.svg': 'image/svg+xml' };

/** 每部影片 3 集，全部指向同一个演示视频，便于验证选集/连播 */
function episodesFor(id) {
  const url = `${BASE}/hls/index.m3u8`;
  return `第1集$${url}#第2集$${url}#第3集$${url}`;
}

function searchResponse(list) {
  return JSON.stringify({
    code: 1,
    msg: '数据列表',
    page: 1,
    pagecount: 1,
    limit: '20',
    total: list.length,
    list,
  });
}

function posterSvg(title, hue) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},60%,28%)"/><stop offset="1" stop-color="hsl(${hue + 40},70%,12%)"/>
  </linearGradient></defs>
  <rect width="400" height="600" fill="url(#g)"/>
  <circle cx="320" cy="120" r="90" fill="hsl(${hue + 20},80%,55%)" opacity="0.5"/>
  <text x="30" y="520" fill="#ffffff" font-family="sans-serif" font-size="34" font-weight="bold">${title}</text>
  <text x="30" y="560" fill="#ffffffaa" font-family="sans-serif" font-size="20">LIBRETV DEMO</text>
</svg>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, BASE);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/api.php/provide/vod') {
    const ids = url.searchParams.get('ids');
    if (ids) {
      const movie = MOVIES.find((m) => String(m.vod_id) === ids);
      const list = movie
        ? [{ ...movie, vod_play_url: episodesFor(movie.vod_id), vod_director: '郭帆', vod_actor: '吴京 / 刘德华' }]
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(searchResponse(list));
      return;
    }
    const wd = (url.searchParams.get('wd') || '').trim();
    const list = MOVIES.filter((m) => !wd || m.vod_name.includes(wd)).map((m) => ({
      ...m,
      vod_play_url: episodesFor(m.vod_id),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(searchResponse(list));
    return;
  }

  if (url.pathname.startsWith('/img/')) {
    const id = url.pathname.replace('/img/', '').replace('.svg', '');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(posterSvg(`DEMO ${id}`, Number(id) * 47));
    return;
  }

  if (url.pathname === '/live.m3u') {
    const body = [
      '#EXTM3U x-tvg-url="' + BASE + '/epg.xml"',
      '#EXTINF:-1 tvg-id="demo1" tvg-name="演示一台" tvg-logo="' + BASE + '/img/4.svg" group-title="演示频道",演示一台',
      `${BASE}/hls/index.m3u8`,
      '#EXTINF:-1 tvg-id="demo2" tvg-name="演示二台" group-title="演示频道",演示二台',
      `${BASE}/hls/index.m3u8?ch=2`,
      '#EXTINF:-1 tvg-id="demo3" tvg-name="测试台" group-title="其他",测试台',
      `${BASE}/hls/index.m3u8?ch=3`,
    ].join('\n');
    res.writeHead(200, { 'Content-Type': 'application/x-mpegURL', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (url.pathname === '/epg.xml') {
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) =>
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
    const now = Date.now();
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="${fmt(new Date(now - 600000))}" stop="${fmt(new Date(now + 1800000))}" channel="demo1">
    <title>演示节目 · 正在播出</title><desc>LibreTV 演示节目单</desc>
  </programme>
  <programme start="${fmt(new Date(now + 1800000))}" stop="${fmt(new Date(now + 3600000))}" channel="demo1">
    <title>演示节目 · 下一档</title>
  </programme>
</tv>`;
    res.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (url.pathname.startsWith('/hls/')) {
    const rel = normalize(url.pathname.slice('/hls/'.length)).replace(/^(\.\.[/\\])+/, '');
    const file = join(MEDIA_DIR, rel);
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock CMS on ${BASE}  (media: ${MEDIA_DIR})`);
});
