import { useEffect, useRef, useState } from 'react';
import { initBridge } from './lib/bridge';
import { useAppStore } from './lib/store';
import { ToastProvider } from './components/Toast';
import { Icon, type IconName } from './components/Icons';
import logo from './assets/logo.png';
import { HomePage } from './pages/Home';
import { SearchPage } from './pages/Search';
import { LivePage } from './pages/Live';
import { SettingsPage } from './pages/Settings';
import { CategoryPage, type CategoryKey } from './pages/Category';
import { WatchPage, type WatchTarget } from './pages/Watch';

type View = 'home' | 'search' | 'live' | 'settings' | 'category';

const NAV: { id: View; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: '首页' },
  { id: 'search', icon: 'search', label: '搜索' },
  { id: 'live', icon: 'radio', label: '直播' },
  { id: 'settings', icon: 'sliders', label: '设置' },
];

export function App() {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>('home');
  const [category, setCategory] = useState<CategoryKey>('movie');
  const [keyword, setKeyword] = useState('');
  const [input, setInput] = useState('');
  const [watch, setWatch] = useState<WatchTarget | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const theme = useAppStore((s) => s.settings.theme);

  useEffect(() => {
    void initBridge().then(() => {
      setReady(true);
      // 首次启动导入内置默认源（之后不再自动加回，用户删掉就是删掉）
      useAppStore.getState().seedDefaults();
    });
  }, []);

  useEffect(() => {
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [theme]);

  // 全局快捷键：Ctrl/Cmd + F 聚焦搜索，Ctrl/Cmd + 1..4 切页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (watch) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setView('search');
        inputRef.current?.focus();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        setView(NAV[Number(e.key) - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [watch]);

  const startSearch = (kw: string) => {
    setInput(kw);
    setKeyword(kw);
    setView('search');
    if (!kw) setTimeout(() => inputRef.current?.focus(), 0);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const kw = input.trim();
    if (!kw) return;
    setKeyword(kw);
    setView('search');
  };

  if (!ready) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', color: '#8d97a8' }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <ToastProvider>
      <div className="app">
        <aside className="rail">
          <div className="brand" title="LibreTV">
            <img src={logo} alt="LibreTV" />
          </div>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`rail-btn${(view === item.id || (view === 'category' && item.id === 'home')) ? ' active' : ''}`}
              title={`${item.label}（Ctrl+${NAV.indexOf(item) + 1}）`}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} size={21} />
            </button>
          ))}
          <div className="rail-foot">LIBRETV DESKTOP</div>
        </aside>

        <main className="main">
          <div className="topbar">
            <form className="search-box" onSubmit={submit}>
              <Icon name="search" size={17} />
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="搜索影片、剧集、综艺…（Ctrl+F）"
                spellCheck={false}
              />
              {input ? (
                <button
                  type="button"
                  onClick={() => {
                    setInput('');
                    inputRef.current?.focus();
                  }}
                  style={{ color: '#5f6a7c', display: 'grid', placeItems: 'center' }}
                >
                  <Icon name="x" size={15} />
                </button>
              ) : null}
            </form>
            <button className="btn ghost" onClick={() => setView('settings')} title="设置">
              <Icon name="sliders" size={17} />
              设置
            </button>
          </div>

          <div className="content">
            {view === 'home' ? (
              <HomePage
                onPlay={setWatch}
                onOpenSettings={() => setView('settings')}
                onSearch={startSearch}
                onCategory={(key) => {
                  setCategory(key);
                  setView('category');
                }}
              />
            ) : null}
            {view === 'category' ? (
              <CategoryPage
                category={category}
                onCategoryChange={setCategory}
                onPlay={setWatch}
                onOpenSettings={() => setView('settings')}
              />
            ) : null}
            {view === 'search' ? (
              <SearchPage keyword={keyword} onPlay={setWatch} onOpenSettings={() => setView('settings')} />
            ) : null}
            {view === 'live' ? <LivePage onOpenSettings={() => setView('settings')} /> : null}
            {view === 'settings' ? <SettingsPage /> : null}
          </div>
        </main>
      </div>

      {watch ? <WatchPage target={watch} onClose={() => setWatch(null)} /> : null}
    </ToastProvider>
  );
}
