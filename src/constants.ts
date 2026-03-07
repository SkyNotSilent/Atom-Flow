import { AtomCard } from './types';

export const CARD_COLORS: Record<string, { main: string, bg: string, darkBg: string }> = {
  '观点': { main: '#805AD5', bg: '#FAF5FF', darkBg: 'rgba(128, 90, 213, 0.15)' },
  '论据': { main: '#3182CE', bg: '#EBF8FF', darkBg: 'rgba(49, 130, 206, 0.15)' },
  '数据': { main: '#38A169', bg: '#F0FFF4', darkBg: 'rgba(56, 161, 105, 0.15)' },
  '金句': { main: '#DD6B20', bg: '#FFFAF0', darkBg: 'rgba(221, 107, 32, 0.15)' },
  '案例': { main: '#D69E2E', bg: '#FFFFF0', darkBg: 'rgba(214, 158, 46, 0.15)' },
};
