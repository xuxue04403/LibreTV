import { useEffect, useState } from 'react';
import { posterUrl } from '../lib/bridge';

/** 海报图：经本地代理加载，失败时退化为首字占位块 */
export function Poster({
  src,
  alt,
  className,
}: {
  src?: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // 换片/换源时组件实例会被复用（列表重排、详情面板换源），
  // failed 若跟着实例走就再也不会变回 false：新海报永远显示成首字色块，
  // 用户会以为这部片子没有封面。src 变了就重置一次。
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const url = !failed ? posterUrl(src) : undefined;

  if (!url) {
    return (
      <div className={`poster-fallback${className ? ` ${className}` : ''}`} aria-label={alt}>
        {alt.trim().slice(0, 2) || '?'}
      </div>
    );
  }
  return (
    <img
      className={className ?? 'poster'}
      src={url}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
