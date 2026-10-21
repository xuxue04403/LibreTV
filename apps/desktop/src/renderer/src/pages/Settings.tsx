import { useState } from 'react';
import {
  exportSourceList,
  parseSnapshot,
  parseSubscription,
  searchSources,
  serializeSnapshot,
  buildSnapshot,
  type AppSettings,
  type LiveSourceConfig,
  type SourceConfig,
} from '@libretv/core';
import { appInfo, http } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { Icon } from '../components/Icons';
import { useToast } from '../components/Toast';

type Tab = 'vod' | 'live' | 'sub' | 'play' | 'data';

const TABS: { id: Tab; label: string }[] = [
  { id: 'vod', label: '点播源' },
  { id: 'live', label: '直播源' },
  { id: 'sub', label: '订阅导入' },
  { id: 'play', label: '播放设置' },
  { id: 'data', label: '数据与关于' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('vod');
  return (
    <div className="settings">
      <div>
        <div className="page-title">设置</div>
        <div className="page-sub">数据源、播放偏好与本地数据都在这里管理</div>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'vod' ? <VodSources /> : null}
      {tab === 'live' ? <LiveSources /> : null}
      {tab === 'sub' ? <SubscriptionPanel /> : null}
      {tab === 'play' ? <PlaybackSettings /> : null}
      {tab === 'data' ? <DataPanel /> : null}
    </div>
  );
}

function VodSources() {
  const sources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const addSource = useAppStore((s) => s.addSource);
  const removeSource = useAppStore((s) => s.removeSource);
  const toggleSource = useAppStore((s) => s.toggleSource);
  const toast = useToast();

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [detail, setDetail] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  const submit = () => {
    const api = url.trim();
    if (!/^https?:\/\//i.test(api)) {
      toast.err('请填写 http(s) 开头的采集接口地址');
      return;
    }
    addSource({
      name: name.trim() || new URL(api).hostname,
      url: api.replace(/\/+$/, ''),
      detail: detail.trim() || undefined,
    });
    setName('');
    setUrl('');
    setDetail('');
    toast.ok('已添加点播源并自动启用');
  };

  const test = async (source: SourceConfig) => {
    setTesting(source.key);
    try {
      const result = await searchSources({ wd: '测试', sources: [source], http, maxPages: 1, timeoutMs: 8000 });
      const outcome = result.outcomes[0];
      setTestResults((prev) => ({
        ...prev,
        [source.key]: outcome.ok ? `可用 · ${outcome.list.length} 条 · ${outcome.ms}ms` : `不可用 · ${outcome.error}`,
      }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <>
      <div className="panel">
        <div className="section-title" style={{ marginTop: 0 }}>
          <span>添加 Apple CMS 采集站</span>
          <span className="hint">接口形如 https://example.com/api.php/provide/vod</span>
        </div>
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>名称（可选）</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="自动取域名" />
          </div>
          <div className="field" style={{ flex: '1 1 320px' }}>
            <label>采集接口地址</label>
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/api.php/provide/vod"
            />
          </div>
          <div className="field" style={{ flex: '0 0 220px' }}>
            <label>详情页根地址（可选）</label>
            <input className="input" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="https://example.com" />
          </div>
          <button className="btn primary" style={{ marginBottom: 12 }} onClick={submit}>
            <Icon name="plus" size={16} />
            添加
          </button>
        </div>
      </div>

      <div className="section-title">
        <span>已添加的点播源（{sources.length}）</span>
        <span className="hint">关闭开关后该源不参与搜索</span>
      </div>

      {sources.length === 0 ? (
        <div className="empty">
          <Icon name="film" size={26} />
          <h3>还没有点播源</h3>
          <div style={{ fontSize: 12.5 }}>可手动添加采集站，或在「订阅导入」里粘贴一份源列表</div>
        </div>
      ) : (
        sources.map((s) => {
          const on = selectedKeys.includes(s.key);
          const testResult = testResults[s.key];
          return (
            <div key={s.key} className="list-item">
              <button className={`switch${on ? ' on' : ''}`} onClick={() => toggleSource(s.key)} aria-label="启用" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="name">{s.name}</div>
                <div className="url">{s.url}</div>
                {s.detail ? <div className="url">详情页：{s.detail}</div> : null}
              </div>
              {testResult ? (
                <span className={`chip ${testResult.startsWith('可用') ? 'ok' : 'err'}`}>{testResult}</span>
              ) : null}
              <button className="btn ghost" onClick={() => void test(s)} disabled={testing === s.key}>
                {testing === s.key ? '测试中…' : '探活'}
              </button>
              <button
                className="btn ghost danger"
                onClick={() => {
                  if (window.confirm(`确定删除「${s.name}」？相关观看历史与收藏也会清除。`)) {
                    removeSource(s.key);
                    toast.push('已删除');
                  }
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          );
        })
      )}
    </>
  );
}

function LiveSources() {
  const sources = useAppStore((s) => s.liveSources);
  const selectedKeys = useAppStore((s) => s.liveSelectedKeys);
  const addLiveSource = useAppStore((s) => s.addLiveSource);
  const removeLiveSource = useAppStore((s) => s.removeLiveSource);
  const toggleLiveSource = useAppStore((s) => s.toggleLiveSource);
  const toast = useToast();

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [epg, setEpg] = useState('');

  const submit = () => {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      toast.err('请填写 http(s) 开头的 M3U 地址');
      return;
    }
    addLiveSource({
      name: name.trim() || new URL(u).hostname,
      url: u,
      epg: epg.trim() || undefined,
    });
    setName('');
    setUrl('');
    setEpg('');
    toast.ok('已添加直播源');
  };

  return (
    <>
      <div className="panel">
        <div className="section-title" style={{ marginTop: 0 }}>
          <span>添加直播源</span>
          <span className="hint">M3U / M3U8 播放列表，可选 XMLTV 节目单</span>
        </div>
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>名称（可选）</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="自动取域名" />
          </div>
          <div className="field" style={{ flex: '1 1 320px' }}>
            <label>M3U 地址</label>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/list.m3u" />
          </div>
          <div className="field" style={{ flex: '0 0 220px' }}>
            <label>EPG 地址（可选）</label>
            <input className="input" value={epg} onChange={(e) => setEpg(e.target.value)} placeholder="https://example.com/epg.xml.gz" />
          </div>
          <button className="btn primary" style={{ marginBottom: 12 }} onClick={submit}>
            <Icon name="plus" size={16} />
            添加
          </button>
        </div>
      </div>

      <div className="section-title">
        <span>已添加的直播源（{sources.length}）</span>
      </div>
      {sources.length === 0 ? (
        <div className="empty">
          <Icon name="radio" size={26} />
          <h3>还没有直播源</h3>
        </div>
      ) : (
        sources.map((s) => {
          const on = selectedKeys.includes(s.key);
          return (
            <div key={s.key} className="list-item">
              <button className={`switch${on ? ' on' : ''}`} onClick={() => toggleLiveSource(s.key)} aria-label="启用" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="name">{s.name}</div>
                <div className="url">{s.url}</div>
                {s.epg ? <div className="url">EPG：{s.epg}</div> : null}
              </div>
              <button
                className="btn ghost danger"
                onClick={() => {
                  removeLiveSource(s.key);
                  toast.push('已删除直播源');
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          );
        })
      )}
    </>
  );
}

function SubscriptionPanel() {
  const importSources = useAppStore((s) => s.importSources);
  const restoreDefaults = useAppStore((s) => s.restoreDefaults);
  const sources = useAppStore((s) => s.sources);
  const liveSources = useAppStore((s) => s.liveSources);
  const toast = useToast();

  const [subUrl, setSubUrl] = useState('');
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = (text: string, from?: string) => {
    const parsed = parseSubscription(text, from);
    const { addedVod, addedLive } = importSources(parsed.sources, parsed.liveSources);
    const skipped = parsed.stats.skipped ? `，跳过 ${parsed.stats.skipped} 条` : '';
    toast.ok(`已导入 ${addedVod} 个点播源、${addedLive} 个直播源${skipped}`);
  };

  const importFromUrl = async () => {
    const u = subUrl.trim();
    if (!/^https?:\/\//i.test(u)) {
      toast.err('请填写订阅地址');
      return;
    }
    setBusy(true);
    try {
      const res = await http.request(u, { timeoutMs: 15_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      apply(res.text, u);
    } catch (err) {
      toast.err(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    const content = exportSourceList(sources, liveSources, 'LibreTV 桌面端源列表');
    if (window.libretv) {
      const result = await window.libretv.saveText('libretv-sources.json', content);
      if (result.ok) toast.ok(`已导出到 ${result.path}`);
    } else {
      await navigator.clipboard.writeText(content);
      toast.ok('已复制到剪贴板');
    }
  };

  return (
    <>
      <div className="panel">
        <div className="section-title" style={{ marginTop: 0 }}>
          <span>从链接订阅</span>
          <span className="hint">支持 LibreTV-SourceList 与 TVBOX 配置（自动识别）</span>
        </div>
        <div className="row">
          <input
            className="input"
            style={{ flex: 1 }}
            value={subUrl}
            onChange={(e) => setSubUrl(e.target.value)}
            placeholder="https://example.com/sources.json"
          />
          <button className="btn primary" onClick={() => void importFromUrl()} disabled={busy}>
            {busy ? '导入中…' : '订阅'}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="section-title" style={{ marginTop: 0 }}>
          <span>粘贴 JSON 导入</span>
          <span className="hint">支持注释与尾随逗号</span>
        </div>
        <textarea
          className="input"
          rows={8}
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder={'{\n  "sources": [{ "name": "示例", "url": "https://example.com/api.php/provide/vod" }],\n  "liveSources": []\n}'}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn"
            onClick={() => {
              try {
                apply(json);
                setJson('');
              } catch (err) {
                toast.err(err instanceof Error ? err.message : '解析失败');
              }
            }}
          >
            导入
          </button>
          <button className="btn ghost" onClick={() => void exportAll()}>
            <Icon name="external" size={15} />
            导出当前源列表
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              restoreDefaults();
              toast.ok('已恢复内置默认源');
            }}
          >
            <Icon name="refresh" size={15} />
            恢复默认源
          </button>
        </div>
      </div>
    </>
  );
}

function PlaybackSettings() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const toggles: { key: keyof AppSettings; title: string; desc: string }[] = [
    { key: 'adultFilter', title: '成人内容过滤', desc: '搜索时过滤含敏感分类关键词的条目' },
    { key: 'adFilter', title: '播放列表广告过滤', desc: '剔除 m3u8 中带广告特征的 DISCONTINUITY 分段' },
    { key: 'autoplayNext', title: '自动连播下一集', desc: '当前集播放结束后自动播放下一集' },
    { key: 'resumePlayback', title: '记住播放进度', desc: '下次打开同一影片时从上次位置继续播放' },
  ];

  return (
    <div className="panel">
      {toggles.map((t) => (
        <div key={t.key} className="list-item" style={{ background: 'transparent' }}>
          <div style={{ flex: 1 }}>
            <div className="name">{t.title}</div>
            <div className="url" style={{ maxWidth: 'none' }}>
              {t.desc}
            </div>
          </div>
          <button
            className={`switch${settings[t.key] ? ' on' : ''}`}
            onClick={() => updateSettings({ [t.key]: !settings[t.key] } as Partial<AppSettings>)}
            aria-label={t.title}
          />
        </div>
      ))}
      <div className="list-item" style={{ background: 'transparent', border: 'none', paddingLeft: 14 }}>
        <div style={{ flex: 1 }}>
          <div className="name">主题</div>
          <div className="url">桌面端默认深色；浅色主题用于明亮环境</div>
        </div>
        <select
          className="input"
          style={{ width: 140 }}
          value={settings.theme}
          onChange={(e) => updateSettings({ theme: e.target.value as AppSettings['theme'] })}
        >
          <option value="dark">深色</option>
          <option value="light">浅色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>
    </div>
  );
}

function DataPanel() {
  const state = useAppStore();
  const replaceAll = useAppStore((s) => s.replaceAll);
  const clearHistory = useAppStore((s) => s.clearHistory);
  const toast = useToast();

  const exportAll = async () => {
    const snapshot = buildSnapshot({
      settings: state.settings,
      sources: state.sources,
      selectedKeys: state.selectedKeys,
      liveSources: state.liveSources,
      liveSelectedKeys: state.liveSelectedKeys,
      history: state.history,
      favorites: state.favorites,
      liveFavorites: state.liveFavorites,
    });
    const content = serializeSnapshot(snapshot);
    if (window.libretv) {
      const result = await window.libretv.saveText('libretv-backup.json', content);
      if (result.ok) toast.ok('配置已导出');
    } else {
      await navigator.clipboard.writeText(content);
      toast.ok('已复制到剪贴板');
    }
  };

  const importAll = async () => {
    if (!window.libretv) {
      toast.err('浏览器预览模式下不可用');
      return;
    }
    const file = await window.libretv.openText();
    if (!file.ok || !file.content) return;
    const snapshot = parseSnapshot(file.content);
    if (!snapshot) {
      toast.err('不是可识别的 LibreTV 配置');
      return;
    }
    replaceAll(snapshot);
    toast.ok(`已导入 ${snapshot.sources.length} 个源、${snapshot.history.length} 条历史`);
  };

  const info = appInfo();

  return (
    <>
      <div className="panel">
        <div className="section-title" style={{ marginTop: 0 }}>
          <span>本地数据</span>
          <span className="hint">全部保存在本机，不上传任何服务器</span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => void exportAll()}>
            <Icon name="external" size={15} />
            导出配置与历史
          </button>
          <button className="btn" onClick={() => void importAll()}>
            <Icon name="link" size={15} />
            导入配置
          </button>
          <button
            className="btn ghost danger"
            onClick={() => {
              if (window.confirm('清空全部观看历史？')) {
                clearHistory();
                toast.push('历史已清空');
              }
            }}
          >
            清空观看历史
          </button>
        </div>
        <div className="row" style={{ marginTop: 14, color: '#8d97a8', fontSize: 12, gap: 18 }}>
          <span>点播源 {state.sources.length}</span>
          <span>直播源 {state.liveSources.length}</span>
          <span>历史 {state.history.length}</span>
          <span>收藏 {state.favorites.length + state.liveFavorites.length}</span>
        </div>
      </div>

      <div className="panel">
        <div className="section-title" style={{ marginTop: 0 }}>
          <span>关于 LibreTV 桌面端</span>
          <span className="hint">v{info.version}</span>
        </div>
        <div style={{ color: '#b6c0d0', fontSize: 12.5, lineHeight: 1.9 }}>
          基于 <b>LibreTV</b>（AGPL-3.0-or-later）的衍生客户端，把上游 Next.js 服务端的
          采集聚合、解析与广告过滤逻辑下放到本地运行，因此无需部署服务器、无需访问密码。
          <br />
          本项目不内置、不存储、不制作任何视频内容，仅提供第三方公开接口的解析与播放能力。
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn ghost"
            onClick={() => void window.libretv?.openExternal('https://github.com/LibreSpark/LibreTV')}
          >
            <Icon name="external" size={15} />
            上游项目
          </button>
          <button
            className="btn ghost"
            onClick={() => void window.libretv?.openExternal('https://www.gnu.org/licenses/agpl-3.0.html')}
          >
            AGPL-3.0 许可
          </button>
        </div>
      </div>
    </>
  );
}
