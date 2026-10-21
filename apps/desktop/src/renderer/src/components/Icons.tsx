type IconName =
  | 'home'
  | 'search'
  | 'tv'
  | 'sliders'
  | 'play'
  | 'pause'
  | 'heart'
  | 'x'
  | 'left'
  | 'right'
  | 'next'
  | 'volume'
  | 'mute'
  | 'maximize'
  | 'minimize'
  | 'refresh'
  | 'plus'
  | 'trash'
  | 'link'
  | 'check'
  | 'list'
  | 'film'
  | 'radio'
  | 'info'
  | 'external';

const PATHS: Record<IconName, string | string[]> = {
  home: 'M3 10.6 12 3l9 7.6V21a1 1 0 0 1-1 1h-5.2v-7H9.2v7H4a1 1 0 0 1-1-1z',
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  tv: ['M3 8h18v12H3z', 'M8 3l4 4 4-4'],
  sliders: ['M4 6h10', 'M18 6h2', 'M4 12h4', 'M12 12h8', 'M4 18h10', 'M18 18h2'],
  play: 'M8 5v14l11-7z',
  pause: ['M9 5v14', 'M15 5v14'],
  heart: 'M12 20.5S3.5 15 3.5 9.3A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 2.7C20.5 15 12 20.5 12 20.5z',
  x: ['M5 5l14 14', 'M19 5L5 19'],
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  next: ['M6 5l9 7-9 7z', 'M18 5v14'],
  volume: ['M4 9v6h3.5L13 20V4L7.5 9z', 'M16.5 8.5a5 5 0 0 1 0 7'],
  mute: ['M4 9v6h3.5L13 20V4L7.5 9z', 'M17 9l4 6', 'M21 9l-4 6'],
  maximize: ['M8 3H3v5', 'M16 3h5v5', 'M21 16v5h-5', 'M3 16v5h5'],
  minimize: ['M8 3v5H3', 'M21 8h-5V3', 'M16 21v-5h5', 'M3 16h5v5'],
  refresh: ['M20 11a8 8 0 1 0-2.3 6.3', 'M20 4v7h-7'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 14h10l1-14'],
  link: ['M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'],
  check: 'M4 12l5 5L20 6',
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  film: ['M3 4h18v16H3z', 'M7 4v16', 'M17 4v16', 'M3 9h4', 'M3 15h4', 'M17 9h4', 'M17 15h4'],
  radio: ['M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M7.5 7.5a6.5 6.5 0 0 0 0 9', 'M16.5 7.5a6.5 6.5 0 0 1 0 9', 'M4.5 4.5a11 11 0 0 0 0 15', 'M19.5 4.5a11 11 0 0 1 0 15'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v6', 'M12 7.5h.01'],
  external: ['M14 4h6v6', 'M10 14L20 4', 'M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6'],
};

export function Icon({
  name,
  size = 18,
  filled = false,
  className,
}: {
  name: IconName;
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  const d = PATHS[name];
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

export type { IconName };
