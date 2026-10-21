import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** 顶层错误边界：渲染期异常时给出可读提示，而不是整页空白 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('LibreTV 渲染异常', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 40, color: '#e9edf5', fontFamily: 'system-ui' }}>
        <h2 style={{ marginBottom: 8 }}>界面出错了</h2>
        <div style={{ color: '#8d97a8', fontSize: 13, marginBottom: 16 }}>
          可以点击下方按钮重新加载；若持续出现，请反馈错误信息。
        </div>
        <pre
          style={{
            background: '#13171f',
            border: '1px solid #242b38',
            borderRadius: 10,
            padding: 14,
            fontSize: 12,
            overflow: 'auto',
            maxHeight: 320,
          }}
        >
          {error.message}
          {'\n\n'}
          {error.stack}
        </pre>
        <button
          className="btn primary"
          style={{ marginTop: 16 }}
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    );
  }
}
