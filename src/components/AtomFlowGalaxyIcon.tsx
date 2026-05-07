import React, { useId } from 'react';

type AtomFlowGalaxyIconProps = {
  size?: number | string;
  className?: string;
  title?: string;
};

export const AtomFlowGalaxyIcon: React.FC<AtomFlowGalaxyIconProps> = ({
  size = 24,
  className,
  title
}) => {
  const id = useId().replace(/:/g, '');
  const armAId = `atomflow-galaxy-arm-a-${id}`;
  const armBId = `atomflow-galaxy-arm-b-${id}`;
  const pixelId = `atomflow-galaxy-pixel-${id}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={armAId} x1="3" y1="6" x2="21" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#E0F2FE" />
          <stop offset="28%" stopColor="#60A5FA" />
          <stop offset="64%" stopColor="#2563EB" />
          <stop offset="100%" stopColor="#0F2D8F" />
        </linearGradient>
        <linearGradient id={armBId} x1="4" y1="19" x2="20" y2="5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1D4ED8" />
          <stop offset="48%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#DBEAFE" />
        </linearGradient>
        <filter id={pixelId} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0" stdDeviation="0.45" floodColor="#7DD3FC" floodOpacity="0.85" />
        </filter>
      </defs>
      <path
        d="M11 2h3v2h3v2h2v3h2v5h-2v3h-2v2h-3v2h-5v-2H6v-2H4v-3H2V9h2V6h2V4h5z"
        fill="#0B1E63"
      />
      <path
        d="M9 4h5v2h3v3h2v4h-2v3h-3v2H9v-2H6v-3H4V9h2V6h3z"
        fill="#1D4ED8"
        opacity="0.76"
      />
      <path
        d="M3.35 12.25c1.1-4.8 7.45-8.02 12.2-5.6 4.52 2.31 4.83 8.4.52 10.95-3.9 2.31-9.25.58-9.86-2.64-.42-2.23 1.77-4.07 4.18-3.6 1.75.34 3.06 1.69 3.01 3.05"
        stroke={`url(#${armAId})`}
        strokeWidth="2.5"
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
      <path
        d="M20.5 9.1c1.04 3.5-1.2 7.42-5.15 8.7-4.9 1.58-10.16-1.38-10.78-5.08"
        stroke={`url(#${armBId})`}
        strokeWidth="1.75"
        strokeLinecap="butt"
        strokeLinejoin="miter"
        opacity="0.9"
      />
      <path
        d="M8.1 8.75h1.55v1.55H8.1zM14.65 7.15h1.35V8.5h-1.35zM15.9 13.9h1.65v1.65H15.9zM6.35 14.7H7.8v1.45H6.35zM11.45 17.05h1.25v1.25h-1.25zM18.15 10.65h1.1v1.1h-1.1z"
        fill="#BAE6FD"
        filter={`url(#${pixelId})`}
      />
      <path
        d="M11.75 8.95l.52 1.45 1.45.52-1.45.52-.52 1.45-.52-1.45-1.45-.52 1.45-.52.52-1.45zM15.15 15.5l.35.98.98.35-.98.35-.35.98-.35-.98-.98-.35.98-.35.35-.98z"
        fill="#F8FBFF"
        opacity="0.96"
      />
      <path
        d="M5.05 10.1h1.05v1.05H5.05zM17.6 5.8h1.15v1.15H17.6zM4.45 17.45H5.8v1.35H4.45zM19.55 15.9h1.2v1.2h-1.2zM16.9 17.6h.9v.9h-.9z"
        fill="#818CF8"
        opacity="0.82"
      />
      <path d="M11.1 11.1h2.2v2.2h-2.2zM11.75 10.45h.9v3.5h-.9zM10.45 11.75h3.5v.9h-3.5z" fill="#FFFFFF" opacity="0.94" />
    </svg>
  );
};
