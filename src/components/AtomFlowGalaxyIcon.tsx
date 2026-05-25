import React, { useEffect, useId, useState } from 'react';

type AtomFlowGalaxyIconProps = {
  size?: number | string;
  className?: string;
  title?: string;
  animated?: boolean;
};

export const AtomFlowGalaxyIcon: React.FC<AtomFlowGalaxyIconProps> = ({
  size = 24,
  className,
  title,
  animated = false
}) => {
  const id = useId().replace(/:/g, '');
  const prefersReducedMotion = usePrefersReducedMotion();
  const shouldAnimate = animated && !prefersReducedMotion;
  const streamId = `atomflow-constellation-stream-${id}`;
  const nodeId = `atomflow-constellation-node-${id}`;
  const lineId = `atomflow-constellation-line-${id}`;
  const haloId = `atomflow-constellation-halo-${id}`;

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
        <linearGradient id={streamId} x1="4" y1="17" x2="20" y2="7" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2B6CB0" stopOpacity="0.18" />
          <stop offset="42%" stopColor="#7DD3FC" />
          <stop offset="100%" stopColor="#F8FBFF" />
        </linearGradient>
        <linearGradient id={lineId} x1="5" y1="17" x2="18" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2B6CB0" stopOpacity="0.55" />
          <stop offset="58%" stopColor="#38BDF8" stopOpacity="0.78" />
          <stop offset="100%" stopColor="#E0F7FF" stopOpacity="0.9" />
        </linearGradient>
        <radialGradient id={nodeId} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(8.4 12.85) rotate(45) scale(3.2)">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="38%" stopColor="#DFF7FF" />
          <stop offset="100%" stopColor="#2B6CB0" />
        </radialGradient>
        <filter id={haloId} x="-35%" y="-35%" width="170%" height="170%">
          <feDropShadow dx="0" dy="0" stdDeviation="0.7" floodColor="#38BDF8" floodOpacity="0.62" />
        </filter>
      </defs>
      <g filter={`url(#${haloId})`}>
        {shouldAnimate ? (
          <circle cx="12" cy="12" r="8.7" fill="#38BDF8" opacity="0.07">
            <animate attributeName="opacity" values="0.04;0.12;0.04" dur="2.8s" repeatCount="indefinite" />
            <animate attributeName="r" values="7.8;9.15;7.8" dur="2.8s" repeatCount="indefinite" />
          </circle>
        ) : null}
        <g opacity="0.9">
          <path
            d="M4.75 16.35C7.35 9.75 13.35 6.05 19.15 8.45"
            stroke="#2B6CB0"
            strokeWidth="1.45"
            strokeLinecap="round"
            opacity="0.14"
          />
          <g>
            {shouldAnimate ? (
              <animateTransform
                attributeName="transform"
                type="rotate"
                values="-5 12 12;5 12 12;-5 12 12"
                dur="2.8s"
                repeatCount="indefinite"
              />
            ) : null}
            <path
              d="M5.1 15.85C7.65 10.55 13 6.9 18.9 8.45"
              stroke={`url(#${streamId})`}
              strokeWidth="0.86"
              strokeLinecap="round"
            />
          </g>
        </g>
        <g>
          <path
            d="M6.1 8.85L8.4 12.85L11.9 7.25L16.05 9.25L17.6 13.35L14.15 16.65L8.4 12.85L7.05 15.8"
            stroke={`url(#${lineId})`}
            strokeWidth="0.78"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.82"
          />
          <path
            d="M8.4 12.85L16.05 9.25M8.4 12.85L17.6 13.35"
            stroke="#7DD3FC"
            strokeWidth="0.5"
            strokeLinecap="round"
            opacity="0.62"
          />
        </g>
        <circle cx="8.4" cy="12.85" r="2.15" fill="#7DD3FC" opacity="0.2">
          {shouldAnimate ? <animate attributeName="opacity" values="0.18;0.34;0.18" dur="2.4s" repeatCount="indefinite" /> : null}
        </circle>
        <circle cx="8.4" cy="12.85" r="1.36" fill={`url(#${nodeId})`} />
        <circle cx="8.4" cy="12.85" r="0.42" fill="#FFFFFF" />
        {[
          [6.1, 8.85, 0.56],
          [11.9, 7.25, 0.52],
          [16.05, 9.25, 0.56],
          [17.6, 13.35, 0.56],
          [14.15, 16.65, 0.52],
          [7.05, 15.8, 0.52]
        ].map(([cx, cy, r], index) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={index % 2 === 0 ? '#EAFBFF' : '#BFEFFF'}>
            {shouldAnimate ? (
              <animate
                attributeName="opacity"
                values="0.62;1;0.62"
                dur={`${1.8 + index * 0.18}s`}
                begin={`${index * 0.12}s`}
                repeatCount="indefinite"
              />
            ) : null}
          </circle>
        ))}
        <circle cx="19.45" cy="6.45" r="0.3" fill="#F8FBFF" opacity="0.7" />
        <circle cx="4.55" cy="11.2" r="0.28" fill="#38BDF8" opacity="0.62" />
      </g>
    </svg>
  );
};

const usePrefersReducedMotion = () => {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setPrefersReducedMotion(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReducedMotion;
};
