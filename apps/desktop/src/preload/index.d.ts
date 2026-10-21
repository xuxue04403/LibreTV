import type { LibreTVBridge } from './index';

declare global {
  interface Window {
    libretv?: LibreTVBridge;
  }
}

export {};
