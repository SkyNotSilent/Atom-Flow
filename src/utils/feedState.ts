export type FeedPageState = 'loading' | 'error' | 'empty' | 'ready';

export function resolveFeedPageState(input: {
  isLoading: boolean;
  error: string | null;
  itemCount: number;
}): FeedPageState {
  if (input.isLoading && input.itemCount === 0) return 'loading';
  if (input.error && input.itemCount === 0) return 'error';
  if (input.itemCount === 0) return 'empty';
  return 'ready';
}
