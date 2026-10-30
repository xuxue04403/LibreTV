import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ToastContext, type ToastApi, type ToastKind } from './toast-context';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, kind, text }].slice(-4));
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 4200);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ push, ok: (t) => push(t, 'ok'), err: (t) => push(t, 'err') }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
