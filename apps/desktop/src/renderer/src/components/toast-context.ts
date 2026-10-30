import { createContext, useContext } from 'react';

/**
 * Toast 的上下文与 hook 单独放一个文件。
 *
 * `Toast.tsx` 只导出 `ToastProvider` 这一个组件，才能满足
 * `react-refresh/only-export-components`：同一个文件里既导出组件又导出 hook/常量时，
 * 热更新无法只替换组件，只能整文件重载，改样式时播放中的视频也会被打断。
 */

export type ToastKind = 'ok' | 'err' | 'info';

export interface ToastApi {
  push: (text: string, kind?: ToastKind) => void;
  ok: (text: string) => void;
  err: (text: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用');
  return ctx;
}
