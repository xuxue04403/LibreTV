import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startMediaProxy, assertAllowedTarget, type MediaProxy } from './proxy';
import { castToDevice, discoverDevices, stopCast, type DlnaDevice } from './dlna';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** IPC 抓取（元数据接口）的响应上限；大文件走媒体代理的流式路径 */
const MAX_IPC_BODY_BYTES = 16 * 1024 * 1024;

let win: BrowserWindow | null = null;
let proxy: MediaProxy | null = null;

const isDev = !!process.env.ELECTRON_RENDERER_URL;

/**
 * 允许用环境变量指定数据目录。
 *
 * 便携版应当把数据放在 exe 旁边（否则同一台机器上的安装版和便携版会互相覆盖
 * 历史、源和设置），自动化脚本也需要一个干净目录来跑，不能污染用户真实数据。
 * 必须放在 app ready 之前执行，setPath 之后才生效。
 */
const userDataOverride = process.env.LIBRETV_USER_DATA;
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

/** 窗口/任务栏图标：与上游 LibreTV 同一套 artwork（打包后放在 resources/icon.png） */
const appIcon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '../../resources/icon.png');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    icon: appIcon,
    backgroundColor: '#0a0c10',
    autoHideMenuBar: true,
    title: 'LibreTV',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用 electron 模块，开沙箱不需要额外放宽
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  // 站外链接交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win?.webContents.getURL() ?? '';
    if (url !== current) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL as string);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 构建冒烟：LTV_SMOKE=<png 路径> 时加载完成后截图并退出（CI / 本地验证用）
  // LTV_SMOKE_SEED：写入 localStorage 的 zustand 快照（JSON 字符串），用于预置数据源
  // LTV_SMOKE_JS：截图前执行的页面脚本（例如触发搜索、点击卡片）
  // LTV_SMOKE_DELAY：截图前的等待毫秒数（默认 2000），慢异步页面可调大
  const smokeShot = process.env.LTV_SMOKE;
  const smokeSeed = process.env.LTV_SMOKE_SEED;
  const smokeJs = process.env.LTV_SMOKE_JS;
  const smokeDelay = Math.max(0, Number(process.env.LTV_SMOKE_DELAY ?? 2000) || 0);
  if (smokeShot) {
    let seeded = false;
    win.webContents.on('console-message', (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    win.webContents.on('did-finish-load', () => {
      void (async () => {
        if (smokeSeed && !seeded) {
          seeded = true;
          try {
            await win?.webContents.executeJavaScript(
              `localStorage.setItem('libretv-desktop-v1', ${JSON.stringify(smokeSeed)})`
            );
          } catch (err) {
            console.error('smoke seed failed', err);
          }
          win?.webContents.reload();
          return;
        }
        await new Promise((r) => setTimeout(r, smokeDelay));
        if (smokeJs) {
          try {
            await win?.webContents.executeJavaScript(smokeJs);
          } catch (err) {
            console.error('smoke js failed', err);
          }
          await new Promise((r) => setTimeout(r, 6000));
        }
        try {
          const image = await win?.webContents.capturePage();
          if (image) await fs.writeFile(smokeShot, image.toPNG());
        } catch (err) {
          console.error('smoke capture failed', err);
        } finally {
          app.exit(0);
        }
      })();
    });
  }

  win.on('closed', () => {
    win = null;
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出 LibreTV' }],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  proxyBase: proxy?.base ?? '',
  isDev,
}));

ipcMain.handle(
  'http:fetch',
  async (
    _event,
    url: string,
    options?: { headers?: Record<string, string>; timeoutMs?: number; method?: string; body?: string }
  ) => {
    const started = Date.now();
    const fail = (status: number, error: string) => ({
      ok: false,
      status,
      url,
      headers: {} as Record<string, string>,
      text: '',
      bytes: new Uint8Array(),
      ms: Date.now() - started,
      error,
    });

    // 与媒体代理同一套边界：渲染层不能借这条 IPC 探测内网或做任意方法请求
    let target: URL;
    try {
      target = await assertAllowedTarget(url, process.env.LTV_ALLOW_PRIVATE_MEDIA === '1');
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : '地址不可用');
    }
    const method = (options?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') return fail(405, '不支持的请求方法');

    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      Accept: 'application/json, text/plain, */*',
      ...(options?.headers ?? {}),
    };
    try {
      const res = await fetch(target.href, {
        method,
        headers,
        body: options?.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(60_000, Math.max(1000, options?.timeoutMs ?? 12_000))),
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      // 元数据接口正常几十 KB；给 16MB 上限，大文件请走媒体代理
      if (buf.byteLength > MAX_IPC_BODY_BYTES) return fail(413, '响应体过大');
      const headerMap: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headerMap[k.toLowerCase()] = v;
      });
      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        headers: headerMap,
        text: new TextDecoder('utf-8').decode(buf),
        bytes: buf,
        ms: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : '网络请求失败';
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return fail(timeout ? 408 : 0, timeout ? '请求超时' : message);
    }
  }
);

ipcMain.handle('window:toggle-fullscreen', () => {
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

ipcMain.handle('window:set-fullscreen', (_event, value: boolean) => {
  win?.setFullScreen(Boolean(value));
  return Boolean(value);
});

ipcMain.handle('window:minimize', () => win?.minimize());

ipcMain.handle('shell:open-external', async (_event, url: string) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
});

ipcMain.handle('dialog:save-text', async (_event, defaultName: string, content: string) => {
  if (!win) return { ok: false as const, canceled: true };
  const result = await dialog.showSaveDialog(win, {
    // 文件名只取 basename：渲染层不能借此把文件写到任意目录
    defaultPath: path.basename(String(defaultName || 'libretv-export.json')),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false as const, canceled: true };
  await fs.writeFile(result.filePath, content, 'utf8');
  return { ok: true as const, path: result.filePath };
});

// —— DLNA 投屏（发送端） ——
ipcMain.handle('dlna:discover', async () => {
  try {
    return { ok: true as const, devices: await discoverDevices() };
  } catch (err) {
    return { ok: false as const, devices: [], error: err instanceof Error ? err.message : '搜索失败' };
  }
});

ipcMain.handle('dlna:cast', async (_event, device: DlnaDevice, url: string, title: string) => {
  try {
    // 渲染层传来的 device 不可全信：控制地址必须与设备描述同源，且设备描述本身要能被解析
    const deviceUrl = new URL(device.location);
    const control = new URL(device.controlUrl);
    if (control.origin !== deviceUrl.origin) throw new Error('控制地址与设备不同源');
    if (!/^https?:\/\//i.test(url)) throw new Error('投屏地址无效');
    await castToDevice(device, url, title);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : '投屏失败' };
  }
});

ipcMain.handle('dlna:stop', async (_event, device: DlnaDevice) => {
  try {
    await stopCast(device);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : '停止失败' };
  }
});

ipcMain.handle('dialog:open-text', async () => {  if (!win) return { ok: false as const, canceled: true };
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json', 'txt'] }],
  });
  const file = result.filePaths[0];
  if (result.canceled || !file) return { ok: false as const, canceled: true };
  const content = await fs.readFile(file, 'utf8');
  return { ok: true as const, path: file, content };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('org.libretv.desktop');
    proxy = await startMediaProxy();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // closeAllConnections 才能让 keep-alive 下的 server.close 立即回调，否则会挂住退出
    void proxy?.close();
  });
}
