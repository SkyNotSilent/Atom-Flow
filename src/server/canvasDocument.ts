const MEDIA_SHAPE_TYPES = new Set(['image', 'video', 'embed', 'bookmark']);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const readCanvasDocumentSchemaVersion = (snapshot: unknown): number | null => {
  if (!isRecord(snapshot) || !isRecord(snapshot.schema)) return null;
  const version = snapshot.schema.schemaVersion;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : null;
};

export const resolveCanvasDocumentSchemaVersion = (snapshot: unknown, fallback: number): number => (
  readCanvasDocumentSchemaVersion(snapshot) ?? fallback
);

/**
 * Native tldraw media is never authoritative in AtomFlow snapshots: images
 * must pass through the bounded upload API and are represented by business
 * nodes. Reject every native asset/media shape, including remote URLs, so a
 * caller cannot bypass upload ownership checks with a direct document PUT.
 * Text and note content is intentionally ignored.
 */
export const hasEmbeddedCanvasMedia = (snapshot: unknown): boolean => {
  if (!isRecord(snapshot) || !isRecord(snapshot.store)) return false;
  return Object.values(snapshot.store).some(record => {
    if (!isRecord(record)) return false;
    if (record.typeName === 'asset') return true;
    return record.typeName === 'shape'
      && typeof record.type === 'string'
      && MEDIA_SHAPE_TYPES.has(record.type);
  });
};

export type CanvasBusinessLayout = {
  nodeId: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Extract only canonical AtomFlow node geometry from a validated tldraw store. */
export const extractCanvasBusinessLayouts = (snapshot: unknown): CanvasBusinessLayout[] => {
  if (!isRecord(snapshot) || !isRecord(snapshot.store)) return [];
  const layouts = new Map<number, CanvasBusinessLayout>();
  for (const [storeKey, record] of Object.entries(snapshot.store)) {
    if (!isRecord(record) || record.typeName !== 'shape' || record.type !== 'atomflow-node' || !isRecord(record.props)) continue;
    const nodeId = Number(record.props.nodeId);
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) continue;
    const canonicalId = `shape:atomflow-node-${nodeId}`;
    if (storeKey !== canonicalId || record.id !== canonicalId) continue;
    const x = Number(record.x);
    const y = Number(record.y);
    const width = Number(record.props.w);
    const height = Number(record.props.h);
    if (![x, y, width, height].every(Number.isFinite)) continue;
    layouts.set(nodeId, {
      nodeId,
      x: clamp(x, -100_000, 100_000),
      y: clamp(y, -100_000, 100_000),
      width: clamp(width, 160, 1_200),
      height: clamp(height, 120, 1_000),
    });
  }
  return [...layouts.values()];
};
