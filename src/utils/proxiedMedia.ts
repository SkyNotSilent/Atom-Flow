const proxiedUrl = (endpoint: string, value: string | undefined) => {
  if (!value || !/^https?:\/\//i.test(value)) return value;
  return `${endpoint}?url=${encodeURIComponent(value)}`;
};

export const getProxiedImageUrl = (url: string | undefined) => proxiedUrl('/api/image-proxy', url);
export const getProxiedFaviconUrl = (url: string | undefined) => proxiedUrl('/api/favicon-proxy', url);
export const getProxiedAudioUrl = (url: string | undefined) => proxiedUrl('/api/media-proxy', url);
