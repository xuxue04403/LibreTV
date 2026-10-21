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

const bridge = {
  info: (): Promise<{ version: string; platform: string; proxyBase: string; isDev: boolean }> =>
    ipcRenderer.invoke('app:info'),
  http: (url: string, options?: BridgeHttpOptions): Promise<BridgeHttpResponse> =>
    ipcRenderer.invoke('http:fetch', url, options),
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
