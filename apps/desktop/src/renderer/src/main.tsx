import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

/**
 * 全局兜底：接住没人处理的异步 rejection。
 *
 * 代码里有大量 `void somePromise()`（保存设置、导出、投屏…），它们的失败
 * ErrorBoundary 完全接不住——表现就是「点了没反应」，控制台之外毫无痕迹。
 * 这里至少留下一条可查的日志，不至于让用户与开发者都无从下手。
 */
window.addEventListener('unhandledrejection', (event) => {
  console.error('LibreTV 未处理的异步异常', event.reason);
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
