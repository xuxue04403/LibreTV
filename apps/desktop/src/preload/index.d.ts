import type { LibreXTVBridge } from './index';

declare global {
  interface Window {
    librextv?: LibreXTVBridge;
  }
}

export {};
