import React from 'react';
import { useAppContext } from '../context/AppContext';
import type { Article } from '../types';
import { findArticleByIdentity } from '../utils/articleIdentity';
import {
  ArticleReader,
  type ArticleReaderProps,
} from './reader/ArticleReader';
import { PodcastArticleAudioControls } from './podcast/PodcastPlaybackProvider';

// ArticleReader preserves the just-in-time notice that正文文本将发送给当前实例配置的翻译服务。

export {
  ArticleReader,
  buildCitationCapture,
  looksLikeArticleHtml,
  sanitizeArticleHtml,
} from './reader/ArticleReader';
export type {
  ArticleReaderAudioRenderer,
  ArticleReaderAudioRenderProps,
  ArticleReaderProps,
  CitationAction,
  CitationActionAvailability,
  CitationCapture,
} from './reader/ArticleReader';

export function resolveReaderArticle(readingArticle: Article | null, articles: Article[]): Article | null {
  if (!readingArticle) return null;
  return findArticleByIdentity(articles, readingArticle) || readingArticle;
}

export interface ReaderPaneProps extends Pick<
  ArticleReaderProps,
  'audio' | 'citationActionAvailability' | 'className' | 'onCitationCapture' | 'variant'
> {
  onClose?: () => void;
}

/**
 * Context-backed compatibility wrapper used by the existing feed layout.
 * New embedded surfaces can use ArticleReader directly with an explicit article.
 */
export const ReaderPane: React.FC<ReaderPaneProps> = ({
  onClose,
  onCitationCapture,
  citationActionAvailability,
  audio,
  variant,
  className,
}) => {
  const {
    readingArticle,
    setReadingArticle,
    saveArticle,
    showToast,
    isSavingArticle,
    getSavingStageText,
    articles,
  } = useAppContext();
  const currentArticle = resolveReaderArticle(readingArticle, articles);
  const resolvedAudio: ArticleReaderProps['audio'] = audio === undefined || audio === 'default'
    ? ({ article }) => <PodcastArticleAudioControls article={article} />
    : audio;

  return (
    <ArticleReader
      article={currentArticle}
      onClose={() => {
        setReadingArticle(null);
        onClose?.();
      }}
      onSaveArticle={async article => {
        await saveArticle(article.id, article);
      }}
      onToast={showToast}
      isSaving={Boolean(currentArticle && isSavingArticle(currentArticle.id))}
      savingStageText={currentArticle ? getSavingStageText(currentArticle.id) : undefined}
      onCitationCapture={onCitationCapture}
      citationActionAvailability={citationActionAvailability}
      audio={resolvedAudio}
      variant={variant}
      className={className}
    />
  );
};
