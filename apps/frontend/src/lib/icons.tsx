import React from 'react';

interface IconProps {
  size?: number;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}

export const IconLogo = ({ size = 20, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className}>
    <rect x="2" y="2" width="7" height="7" rx="1.5" fill="var(--accent)" />
    <rect x="11" y="2" width="7" height="7" rx="1.5" fill="var(--accent)" opacity="0.6" />
    <rect x="2" y="11" width="7" height="7" rx="1.5" fill="var(--accent)" opacity="0.6" />
    <rect x="11" y="11" width="7" height="7" rx="1.5" fill="var(--accent)" opacity="0.3" />
  </svg>
);

export const IconChev = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M3.5 5.25L7 8.75L10.5 5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconArrowRight = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M3 7H11M11 7L7.5 3.5M11 7L7.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconCheck = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M2.5 7.5L5.5 10.5L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconPlus = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M7 2.5V11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const IconX = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const IconSpark = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M7 1L8.5 5.5H13L9.5 8.5L10.5 13L7 10.5L3.5 13L4.5 8.5L1 5.5H5.5L7 1Z" fill="currentColor" />
  </svg>
);

export const IconShield = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M7 1.5L12 3.5V7C12 9.8 9.8 12.2 7 13C4.2 12.2 2 9.8 2 7V3.5L7 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M4.5 7L6 8.5L9.5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconBolt = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M8 1.5L3 8H7L6 12.5L11 6H7L8 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

export const IconEye = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M1 7C1 7 3.5 3 7 3C10.5 3 13 7 13 7C13 7 10.5 11 7 11C3.5 11 1 7 1 7Z" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="7" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

export const IconBell = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M7 1.5C7 1.5 4 3 4 7V10H10V7C10 3 7 1.5 7 1.5Z" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5.5 10C5.5 10.8 6.2 11.5 7 11.5C7.8 11.5 8.5 10.8 8.5 10" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

export const IconWallet = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <rect x="1.5" y="3.5" width="11" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M1.5 6H12.5" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="9.5" cy="8.5" r="0.75" fill="currentColor" />
  </svg>
);

export const IconSafe = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="7" cy="7" r="0.5" fill="currentColor" />
  </svg>
);

export const IconRefresh = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M11.5 3C10.3 1.8 8.7 1 7 1C3.7 1 1 3.7 1 7C1 10.3 3.7 13 7 13C9.6 13 11.8 11.4 12.7 9.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M11.5 3V6H8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconFilter = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M1.5 3.5H12.5M3.5 7H10.5M5.5 10.5H8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

export const IconDownload = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M7 1.5V9M7 9L4.5 6.5M7 9L9.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 11.5H12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

export const IconCmd = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path d="M4.5 4.5C4.5 3.4 3.6 2.5 2.5 2.5C1.4 2.5 0.5 3.4 0.5 4.5C0.5 5.6 1.4 6.5 2.5 6.5H4.5V4.5Z" stroke="currentColor" strokeWidth="1.1" />
    <path d="M9.5 4.5C9.5 3.4 10.4 2.5 11.5 2.5C12.6 2.5 13.5 3.4 13.5 4.5C13.5 5.6 12.6 6.5 11.5 6.5H9.5V4.5Z" stroke="currentColor" strokeWidth="1.1" />
    <path d="M4.5 9.5C4.5 10.6 3.6 11.5 2.5 11.5C1.4 11.5 0.5 10.6 0.5 9.5C0.5 8.4 1.4 7.5 2.5 7.5H4.5V9.5Z" stroke="currentColor" strokeWidth="1.1" />
    <path d="M9.5 9.5C9.5 10.6 10.4 11.5 11.5 11.5C12.6 11.5 13.5 10.6 13.5 9.5C13.5 8.4 12.6 7.5 11.5 7.5H9.5V9.5Z" stroke="currentColor" strokeWidth="1.1" />
    <rect x="4.5" y="4.5" width="5" height="5" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);
