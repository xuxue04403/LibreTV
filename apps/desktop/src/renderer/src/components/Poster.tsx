import { useState } from 'react';
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
