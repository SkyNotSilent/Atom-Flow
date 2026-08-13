import type { WriteCanvasProject } from '../types';

export const CANVAS_PROJECTS_CHANGED_EVENT = 'atomflow-canvas-projects-changed';
export const CANVAS_PROJECT_SELECTION_REQUEST_EVENT = 'atomflow-canvas-select-project';
export const CANVAS_PROJECT_SELECTION_RESULT_EVENT = 'atomflow-canvas-select-project-result';
export const CANVAS_EXTERNAL_CONTENT_CHANGED_EVENT = 'atomflow-canvas-external-content-changed';

const CANVAS_PROJECT_TARGET_STORAGE_PREFIX = 'atomflow:canvas-project-target:v1:';

type CanvasProjectReference = Pick<WriteCanvasProject, 'id'>;
type CanvasProjectTargetStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type CanvasProjectsChangedDetail = {
  ownerId: number;
  projects: WriteCanvasProject[];
  currentProjectId: number | null;
};

export type CanvasProjectSelectionRequestDetail = {
  ownerId: number;
  requestId: string;
  projectId: number;
};

export type CanvasProjectSelectionResultDetail = CanvasProjectSelectionRequestDetail & {
  status: 'confirmed' | 'rejected';
  currentProjectId: number | null;
  reason?: string;
};

export type CanvasExternalContentChangedDetail = {
  projectId: number;
  nodeId?: number | null;
};

const browserStorage = (): CanvasProjectTargetStorage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const normalizePositiveInteger = (value: unknown): number | null => {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
};

export const canvasProjectTargetStorageKey = (ownerId: number) =>
  `${CANVAS_PROJECT_TARGET_STORAGE_PREFIX}${ownerId}`;

export const readCanvasProjectTarget = (
  ownerId: number | null | undefined,
  storage: CanvasProjectTargetStorage | null = browserStorage(),
): number | null => {
  const normalizedOwnerId = normalizePositiveInteger(ownerId);
  if (!normalizedOwnerId || !storage) return null;
  try {
    return normalizePositiveInteger(storage.getItem(canvasProjectTargetStorageKey(normalizedOwnerId)));
  } catch {
    return null;
  }
};

export const rememberCanvasProjectTarget = (
  ownerId: number | null | undefined,
  projectId: number | null,
  storage: CanvasProjectTargetStorage | null = browserStorage(),
) => {
  const normalizedOwnerId = normalizePositiveInteger(ownerId);
  if (!normalizedOwnerId || !storage) return;
  const key = canvasProjectTargetStorageKey(normalizedOwnerId);
  try {
    const normalizedProjectId = normalizePositiveInteger(projectId);
    if (normalizedProjectId) storage.setItem(key, String(normalizedProjectId));
    else storage.removeItem(key);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
};

export const resolveCanvasProjectTarget = (
  projects: CanvasProjectReference[],
  preferredProjectId: number | null | undefined,
): number | null => {
  const preferred = normalizePositiveInteger(preferredProjectId);
  if (preferred && projects.some(project => normalizePositiveInteger(project.id) === preferred)) return preferred;
  return projects.map(project => normalizePositiveInteger(project.id)).find((id): id is number => id !== null) || null;
};

export const createCanvasProjectSelectionRequestId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `canvas-project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const publishCanvasProjectsChanged = (detail: CanvasProjectsChangedDetail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CanvasProjectsChangedDetail>(CANVAS_PROJECTS_CHANGED_EVENT, { detail }));
};

export const requestCanvasProjectSelection = (detail: CanvasProjectSelectionRequestDetail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CanvasProjectSelectionRequestDetail>(CANVAS_PROJECT_SELECTION_REQUEST_EVENT, { detail }));
};

export const publishCanvasProjectSelectionResult = (detail: CanvasProjectSelectionResultDetail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CanvasProjectSelectionResultDetail>(CANVAS_PROJECT_SELECTION_RESULT_EVENT, { detail }));
};
