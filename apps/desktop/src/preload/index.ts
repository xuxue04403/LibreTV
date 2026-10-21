import { contextBridge, ipcRenderer } from 'electron';

export interface BridgeHttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  body?: string;
}

export interface BridgeHttpResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: Record<string, string>;
  text: string;
  bytes: Uint8Array;
  ms: number;
  error?: string;
}

export interface DlnaDeviceInfo {
  name: string;
  location: string;
  controlUrl: string;
}

export interface BridgeStreamResponse {
  ok: boolean;
  status: number;
  url: string;
  headers?: Record<string, string>;
  bytes?: number;
  ms: number;
  error?: string;
}

const bridge = {
  info: (): Promise<{ version: string; platform: string; proxyBase: string; isDev: boolean }> =>
    ipcRenderer.invoke('app:info'),
  http: (url: string, options?: BridgeHttpOptions): Promise<BridgeHttpResponse> =>
    ipcRenderer.invoke('http:fetch', url, options),
  /**
   * 流式抓取：分块通过 `http:stream:chunk` 事件回推。
   *
   * 只暴露「订阅 + 取消」，不把 ipcRenderer 本身交给渲染层，
   * 避免页面能监听任意 IPC 通道。
   */
  stream: (
    url: string,
    options: { headers?: Record<string, string>; idleTimeoutMs?: number; streamId: number },
    onChunk: (chunk: Uint8Array) => void
  ): Promise<BridgeStreamResponse> => {
    const channel = 'http:stream:chunk';
    const listener = (_event: unknown, id: number, chunk: Uint8Array): void => {
      if (id === options.streamId) onChunk(chunk);
    };
    ipcRenderer.on(channel, listener);
    const cleanup = (): void => {
      ipcRenderer.removeListener(channel, listener);
    };
    return ipcRenderer.invoke('http:stream', url, options).finally(cleanup) as Promise<BridgeStreamResponse>;
  },
  streamCancel: (streamId: number): Promise<void> => ipcRenderer.invoke('http:stream:cancel', streamId),
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-fullscreen'),
  setFullscreen: (value: boolean): Promise<boolean> => ipcRenderer.invoke('window:set-fullscreen', value),
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  saveText: (name: string, content: string): Promise<{ ok: boolean; path?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:save-text', name, content),
  openText: (): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:open-text'),
  dlnaDiscover: (): Promise<{ ok: boolean; devices: DlnaDeviceInfo[]; error?: string }> =>
    ipcRenderer.invoke('dlna:discover'),
  dlnaCast: (device: DlnaDeviceInfo, url: string, title: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dlna:cast', device, url, title),
  dlnaStop: (device: DlnaDeviceInfo): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dlna:stop', device),
};

export type LibreTVBridge = typeof bridge;

contextBridge.exposeInMainWorld('libretv', bridge);
