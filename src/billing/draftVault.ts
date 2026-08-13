const DATABASE_NAME = 'atomflow-pro-draft-vault';
const STORE_NAME = 'drafts';

export interface ProtectedDraft {
  id: string;
  userId: number;
  kind: 'article' | 'canvas';
  createdAt: string;
  payload: unknown;
}

const hasIndexedDb = () => typeof window !== 'undefined' && 'indexedDB' in window;

const openDraftDatabase = async (): Promise<IDBDatabase | null> => {
  if (!hasIndexedDb()) return null;
  return new Promise<IDBDatabase | null>(resolve => {
    const request = window.indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
};

const finishTransaction = (transaction: IDBTransaction): Promise<boolean> => new Promise(resolve => {
  transaction.oncomplete = () => resolve(true);
  transaction.onerror = () => resolve(false);
  transaction.onabort = () => resolve(false);
});

export const protectDraft = async (draft: ProtectedDraft): Promise<boolean> => {
  const database = await openDraftDatabase();
  if (!database) return false;
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(draft);
    return await finishTransaction(transaction);
  } catch {
    return false;
  } finally {
    database.close();
  }
};

export const listProtectedDrafts = async (userId: number): Promise<ProtectedDraft[]> => {
  const database = await openDraftDatabase();
  if (!database) return [];
  try {
    const drafts = await new Promise<ProtectedDraft[]>(resolve => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as ProtectedDraft[] : []);
      request.onerror = () => resolve([]);
    });
    return drafts
      .filter(draft => draft.userId === userId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  } finally {
    database.close();
  }
};

export const readProtectedDraft = async (userId: number, draftId: string): Promise<ProtectedDraft | null> => {
  const database = await openDraftDatabase();
  if (!database) return null;
  try {
    const draft = await new Promise<ProtectedDraft | null>(resolve => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(draftId);
      request.onsuccess = () => resolve(request.result as ProtectedDraft | undefined || null);
      request.onerror = () => resolve(null);
    });
    return draft?.userId === userId ? draft : null;
  } finally {
    database.close();
  }
};

export const deleteProtectedDraft = async (userId: number, draftId: string): Promise<boolean> => {
  if (!await readProtectedDraft(userId, draftId)) return false;
  const database = await openDraftDatabase();
  if (!database) return false;
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(draftId);
    return await finishTransaction(transaction);
  } catch {
    return false;
  } finally {
    database.close();
  }
};

export const clearProtectedDrafts = async (userId: number): Promise<number> => {
  const drafts = await listProtectedDrafts(userId);
  if (drafts.length === 0) return 0;
  const database = await openDraftDatabase();
  if (!database) return 0;
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    drafts.forEach(draft => store.delete(draft.id));
    return await finishTransaction(transaction) ? drafts.length : 0;
  } catch {
    return 0;
  } finally {
    database.close();
  }
};

export const downloadProtectedDraft = (draft: ProtectedDraft): boolean => {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  try {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const timestamp = draft.createdAt.replace(/[:.]/g, '-');
    link.href = url;
    link.download = `atomflow-${draft.kind}-draft-${timestamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
};

export const downloadProtectedDraftById = async (userId: number, draftId: string): Promise<boolean> => {
  const draft = await readProtectedDraft(userId, draftId);
  return draft ? downloadProtectedDraft(draft) : false;
};
