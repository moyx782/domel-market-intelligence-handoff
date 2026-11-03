import {Component, type ErrorInfo, type ReactNode} from 'react';

type State = {error: Error | null};

// The app shell used to render a blank page when a child threw (for example a
// malformed backend payload). Keep the shell usable: show a friendly recovery
// screen with the message and a reload action.
export default class ErrorBoundary extends Component<{children: ReactNode}, State> {
 state: State = {error: null};

 static getDerivedStateFromError(error: Error): State {
  return {error};
 }

 componentDidCatch(error: Error, info: ErrorInfo) {
  console.error('UI crashed:', error, info.componentStack);
 }

 render() {
  if (!this.state.error) return this.props.children;
  const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh');
  const title = zh ? '页面出错了' : 'Something went wrong';
  const text = zh
   ? '这个页面没有加载成功。你的数据没有丢失，可以重新加载；如果问题持续出现，请把下面的错误信息发给管理员。'
   : 'This page could not be rendered. Your data is safe — reload to try again. If it keeps happening, send the error below to the administrator.';
  return (
   <div role="alert" className="crash-screen">
    <h1>{title}</h1>
    <p>{text}</p>
    <button className="primary" onClick={() => window.location.reload()}>{zh ? '重新加载页面' : 'Reload page'}</button>
    <details>
     <summary>{zh ? '显示错误详情' : 'Show error details'}</summary>
     <pre>{String(this.state.error.stack ?? this.state.error.message)}</pre>
    </details>
   </div>
  );
 }
}
