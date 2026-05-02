import { AtomCard } from './types';

export const CARD_COLORS: Record<string, { main: string, bg: string, darkBg: string }> = {
  '观点': { main: '#553C9A', bg: '#F5F0FF', darkBg: 'rgba(85, 60, 154, 0.2)' },
  '数据': { main: '#2F855A', bg: '#EEFDF5', darkBg: 'rgba(47, 133, 90, 0.2)' },
  '金句': { main: '#C05621', bg: '#FFF7ED', darkBg: 'rgba(192, 86, 33, 0.2)' },
  '故事': { main: '#B7791F', bg: '#FFFBEA', darkBg: 'rgba(183, 121, 31, 0.2)' },
  '灵感': { main: '#2B6CB0', bg: '#EBF4FF', darkBg: 'rgba(43, 108, 176, 0.2)' },
};
