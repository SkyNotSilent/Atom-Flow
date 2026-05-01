import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Sun, Moon, Plus, Folder, ChevronRight, Trash2, X, LogIn, LogOut } from 'lucide-react';
import { logger } from '../utils/logger';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface NavProps {
  activeTab: 'feed' | 'knowledge' | 'write' | 'discover';
  setActiveTab: (tab: 'feed' | 'knowledge' | 'write' | 'discover') => void;
}

type SourceEntry = {
  id: string;
  type: 'source';
  name: string;
  color: string;
  rssUrl?: string;
  icon?: string;
};

type CollectionEntry = {
  id: string;
  type: 'collection';
  name: string;
  collapsed: boolean;
  children: SourceEntry[];
};

type NavEntry = SourceEntry | CollectionEntry;
type SourceLocation =
  | { type: 'top'; index: number }
  | { type: 'collection'; collectionIndex: number; childIndex: number };
type ContextMenuState =
  | {
      x: number;
      y: number;
      target:
        | { kind: 'collection'; collectionId: string }
        | { kind: 'source'; sourceId: string; inCollectionId?: string };
    }
  | null;
type SourceInputKind = 'keyword' | 'url' | 'rss' | 'rsshub';
type RenameDialogState =
  | { kind: 'collection'; id: string; originalName: string }
  | { kind: 'source'; id: string; originalName: string }
  | null;

const SOURCE_LAYOUT_STORAGE_KEY = 'atomflow:source-layout:v1';
const SOURCE_LAYOUT_VERSION = 2; // 版本2：合集结构

const BASE_SOURCES: Array<{ name: string; color: string }> = [
  { name: '少数派', color: '#553C9A' },
  { name: '人人都是产品经理', color: '#2B6CB0' },
  { name: '36氪', color: '#E53E3E' },
  { name: '虎嗅', color: '#DD6B20' },
  { name: '数字生命卡兹克', color: '#6B46C1' },
  { name: '新智元', color: '#2F855A' },
  { name: '即刻话题', color: '#38A169' },
  { name: 'GitHub Blog', color: '#24292F' },
  { name: 'Sam Altman', color: '#1DA1F2' },
  { name: '张小珺商业访谈录', color: '#FF6B6B' },
  { name: 'Lex Fridman', color: '#000000' },
  { name: 'Y Combinator', color: '#FF0000' },
  { name: 'Andrej Karpathy', color: '#FF0000' }
];

const createSourceEntry = (name: string, color: string, rssUrl?: string, icon?: string): SourceEntry => ({
  id: `source:${name}`,
  type: 'source',
  name,
  color,
  rssUrl,
  icon
});

const createDefaultEntries = (): NavEntry[] => {
  // 创建默认的合集结构
  const collections: NavEntry[] = [
    {
      id: 'collection:国内媒体',
      type: 'collection',
      name: '国内媒体',
      collapsed: true,
      children: [
        createSourceEntry('36氪', '#E53E3E'),
        createSourceEntry('虎嗅', '#DD6B20'),
        createSourceEntry('少数派', '#553C9A'),
        createSourceEntry('人人都是产品经理', '#2B6CB0'),
        createSourceEntry('即刻话题', '#38A169')
      ]
    },
    {
      id: 'collection:播客',
      type: 'collection',
      name: '播客',
      collapsed: true,
      children: [
        createSourceEntry('张小珺商业访谈录', '#FF6B6B')
      ]
    },
    {
      id: 'collection:X',
      type: 'collection',
      name: 'X',
      collapsed: true,
      children: [
        createSourceEntry('Sam Altman', '#1DA1F2')
      ]
    },
    {
      id: 'collection:YouTube',
      type: 'collection',
      name: 'YouTube',
      collapsed: true,
      children: [
        createSourceEntry('Y Combinator', '#FF0000'),
        createSourceEntry('Andrej Karpathy', '#FF0000'),
        createSourceEntry('Lex Fridman', '#000000')
      ]
    },
    {
      id: 'collection:公众号',
      type: 'collection',
      name: '公众号',
      collapsed: true,
      children: [
        createSourceEntry('数字生命卡兹克', '#6B46C1'),
        createSourceEntry('新智元', '#2F855A')
      ]
    },
    {
      id: 'collection:其他',
      type: 'collection',
      name: '其他',
      collapsed: true,
      children: [
        createSourceEntry('GitHub Blog', '#24292F')
      ]
    }
  ];
  
  return collections;
};

const sanitizeStoredEntries = (raw: unknown): NavEntry[] => {
  if (!Array.isArray(raw)) return createDefaultEntries();
  const parsed: NavEntry[] = [];
  const baseColorMap = new Map(BASE_SOURCES.map(item => [item.name, item.color]));
  
  // 已删除的源列表
  const DELETED_SOURCES = new Set(['XYZ播客', '极客公园']);
  
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === 'source' && typeof entry.name === 'string') {
      // 跳过已删除的源
      if (DELETED_SOURCES.has(entry.name)) continue;
      
      const color = typeof entry.color === 'string' ? entry.color : (baseColorMap.get(entry.name) || '#718096');
      const rssUrl = typeof entry.rssUrl === 'string' ? entry.rssUrl : undefined;
      const icon = typeof entry.icon === 'string' ? entry.icon : undefined;
      parsed.push(createSourceEntry(entry.name, color, rssUrl, icon));
      continue;
    }
    if (entry.type === 'collection' && typeof entry.name === 'string' && Array.isArray(entry.children)) {
      const children = entry.children
        .filter(child => child && typeof child === 'object')
        .map(child => child as Record<string, unknown>)
        .filter(child => child.type === 'source' && typeof child.name === 'string')
        .filter(child => !DELETED_SOURCES.has(child.name as string)) // 过滤已删除的源
        .map(child => {
          const childName = child.name as string;
          const color = typeof child.color === 'string' ? child.color : (baseColorMap.get(childName) || '#718096');
          const rssUrl = typeof child.rssUrl === 'string' ? child.rssUrl : undefined;
          const icon = typeof child.icon === 'string' ? child.icon : undefined;
          return createSourceEntry(childName, color, rssUrl, icon);
        });
      if (children.length > 0) {
        parsed.push({
          id: typeof entry.id === 'string' ? entry.id : `collection:${entry.name}`,
          type: 'collection',
          name: entry.name,
          collapsed: Boolean(entry.collapsed),
          children
        });
      }
    }
  }
  
  // 检查是否有缺失的BASE_SOURCES，只补充缺失的，不丢弃用户自定义源
  const usedNames = new Set<string>();
  parsed.forEach(entry => {
    if (entry.type === 'source') usedNames.add(entry.name);
    if (entry.type === 'collection') entry.children.forEach(child => usedNames.add(child.name));
  });

  const missingBaseSources = BASE_SOURCES.filter(source => !usedNames.has(source.name));

  // 只补充缺失的基础源，保留用户自定义源
  if (missingBaseSources.length > 0) {
    for (const src of missingBaseSources) {
      parsed.push({ id: `source:${src.name}`, type: 'source', name: src.name, color: src.color });
    }
  }

  return parsed.length > 0 ? parsed : createDefaultEntries();
};

const loadEntriesFromStorage = (): NavEntry[] => {
  if (typeof window === 'undefined') return createDefaultEntries();
  try {
    const raw = window.localStorage.getItem(SOURCE_LAYOUT_STORAGE_KEY);
    if (!raw) return createDefaultEntries();
    
    const parsed = JSON.parse(raw);
    
    // 检查版本号，如果是旧版本数据，强制使用新的合集结构
    if (parsed.version !== SOURCE_LAYOUT_VERSION) {
      logger.info('Detected legacy source layout, resetting to collection structure', { version: parsed.version });
      const defaultEntries = createDefaultEntries();
      // 保存新版本数据
      window.localStorage.setItem(SOURCE_LAYOUT_STORAGE_KEY, JSON.stringify({
        version: SOURCE_LAYOUT_VERSION,
        entries: defaultEntries
      }));
      return defaultEntries;
    }
    
    return sanitizeStoredEntries(parsed.entries);
  } catch {
    return createDefaultEntries();
  }
};

export const Nav: React.FC<NavProps> = ({ activeTab, setActiveTab }) => {
  const {
    articles, savedCards, savedArticles, theme, toggleTheme, setActiveSource, showToast, reloadArticles, activeSource,
    knowledgeTypeFilter, setKnowledgeTypeFilter, setKnowledgeSourceFilter,
    user, loginAndDo, logout, setShowProfileModal, syncPreferences
  } = useAppContext();
  const [sourceEntries, setSourceEntries] = useState<NavEntry[]>(() => loadEntriesFromStorage());

  // Reload source entries when server preferences are loaded
  useEffect(() => {
    const handler = () => setSourceEntries(loadEntriesFromStorage());
    window.addEventListener('atomflow:preferences-loaded', handler);
    return () => window.removeEventListener('atomflow:preferences-loaded', handler);
  }, []);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: string; position: 'before' | 'after' | 'inside' } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; text: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [contextSubmenu, setContextSubmenu] = useState<'add-source-to-collection' | 'move-source-to-collection' | null>(null);
  const [showAddSourceModal, setShowAddSourceModal] = useState(false);
  const [newSourceInput, setNewSourceInput] = useState('');
  const [newSourceAlias, setNewSourceAlias] = useState('');
  const [renameDialog, setRenameDialog] = useState<RenameDialogState>(null);
  const [renameValue, setRenameValue] = useState('');
  const [loadingSourceId, setLoadingSourceId] = useState<string | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const pointerSessionRef = useRef<{ entryId: string; pointerId: number; startX: number; startY: number; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const iconUpdateDoneRef = useRef(false); // 标记icon是否已更新过
  const unreadCount = articles.filter(a => !a.saved).length;

  // 处理图标加载失败，永久删除无效的 icon URL
  const handleIconError = React.useCallback((sourceId: string) => {
    setSourceEntries(prev => prev.map(entry => {
      if (entry.type === 'source' && entry.id === sourceId) {
        const updated = { ...entry };
        delete updated.icon;
        return updated;
      } else if (entry.type === 'collection') {
        const updatedChildren = entry.children.map(child => {
          if (child.id === sourceId) {
            const updated = { ...child };
            delete updated.icon;
            return updated;
          }
          return child;
        });
        if (updatedChildren.some((child, i) => child !== entry.children[i])) {
          return { ...entry, children: updatedChildren };
        }
      }
      return entry;
    }));
  }, []);

  // 从articles中提取sourceIcon并更新到sourceEntries（只在首次有数据时执行一次）
  useEffect(() => {
    // 如果已经更新过，或者没有文章数据，则跳过
    if (iconUpdateDoneRef.current || articles.length === 0) return;
    
    const sourceIconMap = new Map<string, string>();
    articles.forEach(article => {
      if (article.sourceIcon && !sourceIconMap.has(article.source)) {
        sourceIconMap.set(article.source, article.sourceIcon);
      }
    });
    
    if (sourceIconMap.size === 0) return;
    
    setSourceEntries(prev => prev.map(entry => {
      if (entry.type === 'source') {
        const icon = sourceIconMap.get(entry.name);
        if (icon && !entry.icon) { // 只在没有icon时才设置
          return { ...entry, icon };
        }
      } else if (entry.type === 'collection') {
        const updatedChildren = entry.children.map(child => {
          const icon = sourceIconMap.get(child.name);
          if (icon && !child.icon) { // 只在没有icon时才设置
            return { ...child, icon };
          }
          return child;
        });
        if (updatedChildren.some((child, i) => child !== entry.children[i])) {
          return { ...entry, children: updatedChildren };
        }
      }
      return entry;
    }));
    
    // 标记为已更新
    iconUpdateDoneRef.current = true;
  }, [articles]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const layoutData = { version: SOURCE_LAYOUT_VERSION, entries: sourceEntries };
    window.localStorage.setItem(SOURCE_LAYOUT_STORAGE_KEY, JSON.stringify(layoutData));
    if (user) {
      syncPreferences({ source_layout: layoutData });
    }
  }, [sourceEntries, user, syncPreferences]);

  const handleTabClick = (tab: 'feed' | 'knowledge' | 'write' | 'discover') => {
    if ((tab === 'knowledge' || tab === 'write') && !user) {
      loginAndDo(() => setActiveTab(tab));
      return;
    }
    setActiveTab(tab);
    if (tab === 'feed') {
      setActiveSource(null);
    }
  };

  const entryById = useMemo(() => {
    const map = new Map<string, NavEntry>();
    sourceEntries.forEach(entry => {
      map.set(entry.id, entry);
      if (entry.type === 'collection') {
        entry.children.forEach(child => map.set(child.id, child));
      }
    });
    return map;
  }, [sourceEntries]);

  const collections = useMemo(() => sourceEntries.filter((entry): entry is CollectionEntry => entry.type === 'collection'), [sourceEntries]);

  const findSourceLocation = (entries: NavEntry[], sourceId: string): SourceLocation | null => {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.type === 'source' && entry.id === sourceId) {
        return { type: 'top', index: i };
      }
      if (entry.type === 'collection') {
        const childIndex = entry.children.findIndex(child => child.id === sourceId);
        if (childIndex >= 0) {
          return { type: 'collection', collectionIndex: i, childIndex };
        }
      }
    }
    return null;
  };

  const deleteSource = async (sourceId: string) => {
    const location = findSourceLocation(sourceEntries, sourceId);
    if (!location) return;
    const source = location.type === 'top'
      ? sourceEntries[location.index] as SourceEntry
      : (sourceEntries[location.collectionIndex] as CollectionEntry).children[location.childIndex];
    try {
      await fetch(`/api/sources/${encodeURIComponent(source.name)}`, { method: 'DELETE' });
      if (activeSource === source.name) {
        setActiveSource(null);
      }
      setSourceEntries(prev => {
        const next: NavEntry[] = [];
        prev.forEach(entry => {
          if (entry.type === 'source') {
            if (entry.id !== sourceId) next.push(entry);
            return;
          }
          const children = entry.children.filter(child => child.id !== sourceId);
          next.push(children.length === entry.children.length ? entry : { ...entry, children });
        });
        return next.filter(entry => entry.type !== 'collection' || entry.children.length > 0);
      });
      await reloadArticles();
      showToast('已删除信息源');
    } catch {
      showToast('删除失败，请稍后重试');
    }
  };

  const moveSourceToCollection = (sourceId: string, collectionId: string) => {
    setSourceEntries(prev => {
      const location = findSourceLocation(prev, sourceId);
      const targetCollectionIndex = prev.findIndex(entry => entry.type === 'collection' && entry.id === collectionId);
      if (!location || targetCollectionIndex < 0) return prev;
      const targetCollection = prev[targetCollectionIndex] as CollectionEntry;
      if (location.type === 'collection' && prev[location.collectionIndex].id === collectionId) return prev;
      let sourceItem: SourceEntry | null = null;
      const working = prev.map(entry => entry.type === 'collection' ? { ...entry, children: [...entry.children] } : { ...entry });
      if (location.type === 'top') {
        sourceItem = working[location.index] as SourceEntry;
        working.splice(location.index, 1);
      } else {
        const sourceCollection = working[location.collectionIndex] as CollectionEntry;
        sourceItem = sourceCollection.children[location.childIndex];
        sourceCollection.children.splice(location.childIndex, 1);
      }
      if (!sourceItem) return prev;
      const newTargetIndex = working.findIndex(entry => entry.type === 'collection' && entry.id === collectionId);
      if (newTargetIndex < 0) return prev;
      const newTarget = working[newTargetIndex] as CollectionEntry;
      if (newTarget.children.some(child => child.id === sourceItem!.id)) return prev;
      newTarget.children.push(sourceItem);
      return working.filter(entry => entry.type !== 'collection' || entry.children.length > 0);
    });
  };

  const removeSourceFromCollection = (sourceId: string, collectionId: string) => {
    setSourceEntries(prev => {
      const collectionIndex = prev.findIndex(entry => entry.type === 'collection' && entry.id === collectionId);
      if (collectionIndex < 0) return prev;
      const collection = prev[collectionIndex] as CollectionEntry;
      const childIndex = collection.children.findIndex(child => child.id === sourceId);
      if (childIndex < 0) return prev;
      const source = collection.children[childIndex];
      const working = prev.map(entry => entry.type === 'collection' ? { ...entry, children: [...entry.children] } : { ...entry });
      const targetCollection = working[collectionIndex] as CollectionEntry;
      targetCollection.children.splice(childIndex, 1);
      working.splice(collectionIndex + 1, 0, source);
      return working.filter(entry => entry.type !== 'collection' || entry.children.length > 0);
    });
  };

  const openRenameCollection = (collectionId: string) => {
    const collection = sourceEntries.find(entry => entry.type === 'collection' && entry.id === collectionId);
    if (!collection || collection.type !== 'collection') return;
    setRenameDialog({ kind: 'collection', id: collection.id, originalName: collection.name });
    setRenameValue(collection.name);
  };

  const openRenameSource = (sourceId: string) => {
    const location = findSourceLocation(sourceEntries, sourceId);
    if (!location) return;
    const source = location.type === 'top'
      ? sourceEntries[location.index] as SourceEntry
      : (sourceEntries[location.collectionIndex] as CollectionEntry).children[location.childIndex];
    setRenameDialog({ kind: 'source', id: sourceId, originalName: source.name });
    setRenameValue(source.name);
  };

  const closeRenameDialog = () => {
    setRenameDialog(null);
    setRenameValue('');
  };

  const submitRename = async () => {
    if (!renameDialog) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      showToast('名称不能为空');
      return;
    }
    if (nextName === renameDialog.originalName) {
      closeRenameDialog();
      return;
    }
    if (renameDialog.kind === 'collection') {
      setSourceEntries(prev => prev.map(entry => entry.id === renameDialog.id && entry.type === 'collection'
        ? { ...entry, name: nextName }
        : entry));
      showToast('已重命名合集');
      closeRenameDialog();
      return;
    }
    const duplicate = sourceEntries.some(entry => {
      if (entry.type === 'source') return entry.id !== renameDialog.id && entry.name === nextName;
      return entry.children.some(child => child.id !== renameDialog.id && child.name === nextName);
    });
    if (duplicate) {
      showToast('该信息源名称已存在');
      return;
    }
    try {
      const res = await fetch('/api/sources/rename', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: renameDialog.originalName, to: nextName })
      });
      if (!res.ok) {
        showToast('重命名失败，请稍后重试');
        return;
      }
      setSourceEntries(prev => prev.map(entry => {
        if (entry.type === 'source') {
          return entry.id === renameDialog.id ? { ...entry, name: nextName } : entry;
        }
        return {
          ...entry,
          children: entry.children.map(child => child.id === renameDialog.id ? { ...child, name: nextName } : child)
        };
      }));
      if (activeSource === renameDialog.originalName) {
        setActiveSource(nextName);
      }
      await reloadArticles();
      showToast('已重命名信息源');
      closeRenameDialog();
    } catch {
      showToast('重命名失败，请稍后重试');
    }
  };

  const generateColorFromName = (name: string) => {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 45%)`;
  };

  const detectInputKind = (rawValue: string): SourceInputKind => {
    const value = rawValue.trim().toLowerCase();
    if (value.startsWith('rsshub://')) return 'rsshub';
    if (/^https?:\/\/.+/i.test(value)) {
      if (/(\.xml($|\?)|\/feed($|\/|\?)|rss)/i.test(value)) return 'rss';
      return 'url';
    }
    if (/^[\w-]+\.[\w.-]+/.test(value)) {
      if (/(\.xml($|\?)|\/feed($|\/|\?)|rss)/i.test(value)) return 'rss';
      return 'url';
    }
    return 'keyword';
  };

  const normalizeToHttpUrl = (rawValue: string) => {
    const value = rawValue.trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `https://${value}`;
  };

  const inferNameFromInput = (rawInput: string, kind: SourceInputKind) => {
    const raw = rawInput.trim();
    if (kind === 'keyword') return raw;
    if (kind === 'rsshub') {
      const route = raw.replace(/^rsshub:\/\//i, '');
      const segments = route.split('/').filter(Boolean);
      return segments[segments.length - 1] || 'RSSHub 订阅';
    }
    const url = normalizeToHttpUrl(raw);
    try {
      return new URL(url).hostname.replace(/^www\./, '') || raw;
    } catch {
      return raw;
    }
  };

  const addSource = () => {
    const rawInput = newSourceInput.trim();
    if (!rawInput) {
      showToast('请输入关键词、URL、RSS 或 RSSHub 路由');
      return;
    }
    const kind = detectInputKind(rawInput);
    const name = (newSourceAlias.trim() || inferNameFromInput(rawInput, kind)).trim();
    if (!name) {
      showToast('请输入信息源名称');
      return;
    }
    const normalizedInput = kind === 'url' || kind === 'rss' ? normalizeToHttpUrl(rawInput) : rawInput;
    const exists = sourceEntries.some(entry => {
      if (entry.type === 'source') return entry.name === name;
      return entry.children.some(child => child.name === name);
    });
    if (exists) {
      showToast('该信息源已存在');
      return;
    }
    const rssUrl = kind === 'rsshub' || kind === 'rss' || kind === 'url' ? normalizedInput : undefined;
    const nextSource = createSourceEntry(name, generateColorFromName(name), rssUrl);
    
    // 将新源添加到所有合集的下方（末尾）
    setSourceEntries(prev => [...prev, nextSource]);
    setShowAddSourceModal(false);
    setNewSourceInput('');
    setNewSourceAlias('');
    showToast('已添加信息源');
  };

  const closeAddSourceModal = () => {
    setShowAddSourceModal(false);
    setNewSourceInput('');
    setNewSourceAlias('');
  };

  const openContextMenu = (event: React.MouseEvent, target: NonNullable<ContextMenuState>['target']) => {
    event.preventDefault();
    event.stopPropagation();
    setContextSubmenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  };

  useEffect(() => {
    const closeMenu = () => {
      setContextMenu(null);
      setContextSubmenu(null);
    };
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  const toggleCollectionCollapsed = (collectionId: string) => {
    setSourceEntries(prev => prev.map(entry => {
      if (entry.id !== collectionId || entry.type !== 'collection') return entry;
      return { ...entry, collapsed: !entry.collapsed };
    }));
  };

  const clearDragState = () => {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    pointerSessionRef.current = null;
    setDraggingId(null);
    setDropHint(null);
    setDragPreview(null);
  };

  const applyDrop = (dragId: string, targetId: string, position: 'before' | 'after' | 'inside') => {
    const draggingEntry = entryById.get(dragId);
    const targetEntry = entryById.get(targetId);
    if (!draggingEntry || !targetEntry) {
      return;
    }
    setSourceEntries(prev => {
      const clean = (items: NavEntry[]) => items.filter(item => item.type !== 'collection' || item.children.length > 0);
      const working = prev.map(entry => entry.type === 'collection' ? { ...entry, children: [...entry.children] } : { ...entry });

      if (draggingEntry.type === 'collection') {
        const dragIndex = working.findIndex(entry => entry.id === dragId);
        const targetIndex = working.findIndex(entry => entry.id === targetId);
        if (dragIndex < 0 || targetIndex < 0) return prev;
        const [dragged] = working.splice(dragIndex, 1);
        const targetIndexAfterRemoval = working.findIndex(entry => entry.id === targetId);
        if (targetIndexAfterRemoval < 0) return prev;
        const insertIndex = position === 'after' ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
        working.splice(insertIndex, 0, dragged);
        return clean(working);
      }

      const dragLocation = findSourceLocation(working, dragId);
      if (!dragLocation) return prev;
      let draggedSource: SourceEntry;
      if (dragLocation.type === 'top') {
        draggedSource = working[dragLocation.index] as SourceEntry;
        working.splice(dragLocation.index, 1);
      } else {
        const collection = working[dragLocation.collectionIndex] as CollectionEntry;
        draggedSource = collection.children[dragLocation.childIndex];
        collection.children.splice(dragLocation.childIndex, 1);
      }

      if (targetEntry.type === 'collection') {
        const targetCollectionIndex = working.findIndex(entry => entry.id === targetId && entry.type === 'collection');
        if (targetCollectionIndex < 0) return prev;
        if (position === 'inside') {
          const targetCollection = working[targetCollectionIndex] as CollectionEntry;
          if (!targetCollection.children.some(child => child.id === draggedSource.id)) {
            targetCollection.children.push(draggedSource);
          }
          return clean(working);
        }
        const insertIndex = position === 'after' ? targetCollectionIndex + 1 : targetCollectionIndex;
        working.splice(insertIndex, 0, draggedSource);
        return clean(working);
      }

      const targetLocation = findSourceLocation(working, targetId);
      if (!targetLocation) return prev;

      if (position === 'inside') {
        if (targetLocation.type === 'top') {
          const targetSource = working[targetLocation.index] as SourceEntry;
          const collection: CollectionEntry = {
            id: `collection:${Date.now()}`,
            type: 'collection',
            name: `${targetSource.name} 合集`,
            collapsed: false,
            children: [targetSource, draggedSource]
          };
          working.splice(targetLocation.index, 1, collection);
          return clean(working);
        }
        const targetCollection = working[targetLocation.collectionIndex] as CollectionEntry;
        if (!targetCollection.children.some(child => child.id === draggedSource.id)) {
          const insertAt = targetLocation.childIndex + 1;
          targetCollection.children.splice(insertAt, 0, draggedSource);
        }
        return clean(working);
      }

      if (targetLocation.type === 'top') {
        const insertIndex = position === 'after' ? targetLocation.index + 1 : targetLocation.index;
        working.splice(insertIndex, 0, draggedSource);
        return clean(working);
      }

      const targetCollection = working[targetLocation.collectionIndex] as CollectionEntry;
      const insertAt = position === 'after' ? targetLocation.childIndex + 1 : targetLocation.childIndex;
      targetCollection.children.splice(insertAt, 0, draggedSource);
      return clean(working);
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>, entryId: string) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    suppressClickRef.current = false;
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    pointerSessionRef.current = {
      entryId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false
    };
    holdTimerRef.current = window.setTimeout(() => {
      const session = pointerSessionRef.current;
      if (!session || session.entryId !== entryId) return;
      session.active = true;
      suppressClickRef.current = true;
      setDraggingId(entryId);
      const entry = entryById.get(entryId);
      if (entry?.type === 'source') {
        setDragPreview({ x: event.clientX, y: event.clientY, text: entry.name });
      } else if (entry?.type === 'collection') {
        setDragPreview({ x: event.clientX, y: event.clientY, text: entry.name });
      }
    }, 500);
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = pointerSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      const moved = Math.abs(event.clientX - session.startX) + Math.abs(event.clientY - session.startY);
      if (!session.active && moved > 8) {
        if (holdTimerRef.current) {
          window.clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        pointerSessionRef.current = null;
        return;
      }
      if (!session.active) return;
      event.preventDefault();
      const dragEntry = entryById.get(session.entryId);
      const dragLabel = dragEntry?.type === 'source' ? dragEntry.name : dragEntry?.name || '';
      setDragPreview({ x: event.clientX, y: event.clientY, text: dragLabel });
      const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drag-entry-id]') as HTMLElement | null;
      if (!targetElement) {
        setDropHint(null);
        return;
      }
      const targetId = targetElement.dataset.dragEntryId;
      if (!targetId || targetId === session.entryId) {
        setDropHint(null);
        return;
      }
      const rect = targetElement.getBoundingClientRect();
      const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
      const position: 'before' | 'after' | 'inside' = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
      setDropHint({ targetId, position });
    };

    const onPointerUp = (event: PointerEvent) => {
      const session = pointerSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      if (session.active && dropHint && dropHint.targetId !== session.entryId) {
        applyDrop(session.entryId, dropHint.targetId, dropHint.position);
      }
      clearDragState();
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [dropHint, entryById]);

  useEffect(() => {
    return () => {
      clearDragState();
    };
  }, []);

  const handleSourceClick = async (source: SourceEntry) => {
    if (suppressClickRef.current) return;
    setActiveSource(source.name);
    setActiveTab('feed');
    const hasArticles = articles.some(article => article.source === source.name);
    if (hasArticles || !source.rssUrl || loadingSourceId === source.id) return;
    try {
      setLoadingSourceId(source.id);
      showToast('正在抓取信息源...');
      const res = await fetch('/api/sources/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: source.name, input: source.rssUrl })
      });
      if (!res.ok) {
        showToast('抓取失败，请检查订阅链接');
        return;
      }
      await reloadArticles();
      showToast('信息源已更新');
    } catch {
      showToast('抓取失败，请稍后重试');
    } finally {
      setLoadingSourceId(null);
    }
  };

  const topLevelSources = useMemo(() => sourceEntries.filter((entry): entry is SourceEntry => entry.type === 'source'), [sourceEntries]);
  const knowledgeTypeOptions = ['来源', '观点', '数据', '金句', '故事'];
  const knowledgeTypeCounts = useMemo(() => {
    const counter = new Map<string, number>();
    for (const card of savedCards) {
      counter.set(card.type, (counter.get(card.type) || 0) + 1);
    }
    return counter;
  }, [savedCards]);
  const savedArticlesCount = useMemo(() => savedArticles.length, [savedArticles]);
  const uniqueKnowledgeTagsCount = useMemo(() => new Set(savedCards.flatMap(card => card.tags)).size, [savedCards]);

  const contextCollectionId = contextMenu?.target.kind === 'collection' ? contextMenu.target.collectionId : undefined;
  const contextSourceInCollectionId = contextMenu?.target.kind === 'source' ? contextMenu.target.inCollectionId : undefined;

  const contextTargetCollection =
    contextCollectionId
      ? sourceEntries.find(entry => entry.type === 'collection' && entry.id === contextCollectionId) as CollectionEntry | undefined
      : undefined;

  const contextTargetSourceLocation =
    contextMenu?.target.kind === 'source'
      ? findSourceLocation(sourceEntries, contextMenu.target.sourceId)
      : null;

  const contextTargetSource =
    contextMenu?.target.kind === 'source' && contextTargetSourceLocation
      ? contextTargetSourceLocation.type === 'top'
        ? sourceEntries[contextTargetSourceLocation.index] as SourceEntry
        : (sourceEntries[contextTargetSourceLocation.collectionIndex] as CollectionEntry).children[contextTargetSourceLocation.childIndex]
      : null;

  const getDropClass = (entryId: string) => {
    if (!dropHint || dropHint.targetId !== entryId) return '';
    if (dropHint.position === 'before') return 'border-t-2 border-accent';
    if (dropHint.position === 'after') return 'border-b-2 border-accent';
    return 'bg-accent-light/60';
  };

  const SourceRow: React.FC<{ source: SourceEntry; nested?: boolean; parentCollectionId?: string }> = ({ source, nested = false, parentCollectionId }) => {
    const isActive = activeSource === source.name;
    
    return (
      <div
        data-drag-entry-id={source.id}
        onPointerDown={(event) => {
          event.stopPropagation();
          handlePointerDown(event, source.id);
        }}
        onClick={() => handleSourceClick(source)}
        onContextMenu={(event) => openContextMenu(event, { kind: 'source', sourceId: source.id, inCollectionId: parentCollectionId })}
        title={nested ? source.name : '长按并拖动可排序，拖到其他源上可建合集'}
        className={cn(
          'group flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] cursor-pointer border transition-all duration-150 select-none',
          nested && 'ml-5 py-1',
          draggingId === source.id && 'opacity-25 scale-[0.98]',
          isActive 
            ? 'bg-accent-light text-accent border-accent/30' 
            : 'text-text2 hover:bg-surface2 border-transparent',
          getDropClass(source.id)
        )}
      >
        <div className="flex items-center gap-2">
          {/* 固定尺寸的图标容器，始终占据 16x16px 空间 */}
          <div className="relative w-4 h-4 shrink-0 flex items-center justify-center">
            {source.icon ? (
              // 有图标：显示图标
              <img 
                src={source.icon} 
                alt={source.name}
                className="w-4 h-4 rounded-sm object-cover"
                onError={() => handleIconError(source.id)}
              />
            ) : (
              // 无图标：显示颜色点
              <div 
                className="w-[10px] h-[10px] rounded-full" 
                style={{ backgroundColor: source.color }}
              />
            )}
          </div>
          <span>{source.name}</span>
          {loadingSourceId === source.id && (
            <span className="text-[10px] text-text3">更新中</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <nav className="w-full h-full bg-surface border-r border-border flex flex-col shrink-0 transition-colors">
      <div className="h-28 flex items-end justify-center px-4 pb-3 shrink-0">
        <div className="min-w-0 text-center">
          <div className="font-serif font-semibold text-[14px] leading-none text-text2">
            Atom<span className="text-accent">Flow</span>
          </div>
          <div className="font-serif font-bold text-[22px] leading-none mt-1">
            <span className="text-text-main">原子</span><span className="atomflow-flow-char">流</span>
          </div>
          <div className="text-[11px] text-text3 leading-[1.35] mt-1.5">
            让每一篇看过的知识都成为复利资产
          </div>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-1">
        <TabButton active={activeTab === 'feed'} onClick={() => handleTabClick('feed')} badge={unreadCount} fullWidth>今日推送</TabButton>
        <TabButton active={activeTab === 'discover'} onClick={() => handleTabClick('discover')} fullWidth>
          <Plus size={14} className="inline mr-1" />
          发现订阅源
        </TabButton>
        <TabButton active={activeTab === 'knowledge'} onClick={() => handleTabClick('knowledge')} badge={savedCards.length} fullWidth>我的知识库</TabButton>
        <TabButton active={activeTab === 'write'} onClick={() => handleTabClick('write')} fullWidth>魔法写作</TabButton>

        {activeTab === 'feed' && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2 px-3">
              <div className="text-[11px] font-semibold uppercase text-text3">我的订阅源</div>
              <button 
                onClick={() => setActiveTab('discover')}
                className="w-5 h-5 rounded-full bg-accent-light text-accent flex items-center justify-center hover:bg-accent hover:text-white transition-colors"
                title="发现更多订阅源"
              >
                <Plus size={12} />
              </button>
            </div>
            
            <div className="flex flex-col gap-0.5">
              {sourceEntries.map(entry => (
                <React.Fragment key={entry.id}>
                  {entry.type === 'source' ? (
                    <SourceRow source={entry} />
                  ) : (
                    <div
                      data-drag-entry-id={entry.id}
                      onPointerDown={(event) => handlePointerDown(event, entry.id)}
                      onContextMenu={(event) => openContextMenu(event, { kind: 'collection', collectionId: entry.id })}
                      className={cn(
                        'rounded-lg border border-transparent transition-all duration-150 select-none',
                        draggingId === entry.id && 'opacity-25 scale-[0.98]',
                        getDropClass(entry.id)
                      )}
                    >
                      <div className="group flex items-center justify-between px-3 py-1.5 text-[13px] text-text2 hover:bg-surface2 rounded-lg cursor-pointer">
                        <button
                          onClick={() => toggleCollectionCollapsed(entry.id)}
                          className="flex items-center gap-2 min-w-0"
                        >
                          <ChevronRight size={14} className={cn('transition-transform', entry.collapsed ? '' : 'rotate-90')} />
                          <Folder size={13} />
                          <span className="truncate">{entry.name}</span>
                        </button>
                        <span className="text-[11px] text-text3">{entry.children.length}</span>
                      </div>
                      {!entry.collapsed && (
                        <div className="pb-1">
                          {entry.children.map(child => (
                            <SourceRow key={child.id} source={child} nested parentCollectionId={entry.id} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
            {activeTab === 'feed' && (
              <div className="px-3 pt-2 text-[11px] text-text3">
                长按并拖动可调整顺序，拖到另一个源上可建立合集
              </div>
            )}
          </div>
        )}
        {activeTab === 'knowledge' && (
          <div className="mt-6 flex flex-col gap-3">
            <div className="px-3 text-[11px] font-semibold uppercase text-text3">知识库总览</div>
            <div className="px-3 grid grid-cols-1 gap-2">
              <div className="rounded-lg border border-border bg-surface2 px-3 py-2">
                <div className="text-[16px] font-semibold text-text-main">{savedCards.length}</div>
                <div className="text-[11px] text-text3">原子卡片总数</div>
              </div>
              <div className="rounded-lg border border-border bg-surface2 px-3 py-2">
                <div className="text-[16px] font-semibold text-text-main">{savedArticlesCount}</div>
                <div className="text-[11px] text-text3">来源文章数</div>
              </div>
              <div className="rounded-lg border border-border bg-surface2 px-3 py-2">
                <div className="text-[16px] font-semibold text-text-main">{uniqueKnowledgeTagsCount}</div>
                <div className="text-[11px] text-text3">话题标签数</div>
              </div>
            </div>
            <div className="px-3 pt-1 text-[11px] font-semibold uppercase text-text3">卡片类型</div>
            <div className="px-2 flex flex-col gap-0.5">
              {knowledgeTypeOptions.map(type => {
                const count = type === '来源'
                  ? savedArticlesCount
                  : (knowledgeTypeCounts.get(type) || 0);
                return (
                  <button
                    key={type}
                    onClick={() => {
                      setKnowledgeTypeFilter(type);
                      if (type !== '来源') {
                        setKnowledgeSourceFilter('全部');
                      }
                    }}
                    className={cn(
                      'w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-[13px] transition-colors',
                      knowledgeTypeFilter === type ? 'bg-accent-light text-accent' : 'text-text2 hover:bg-surface2'
                    )}
                  >
                    <span>{type}</span>
                    <span className="text-[11px] text-text3">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {dragPreview && (
        <div
          className="fixed pointer-events-none z-[100] -translate-x-1/2 -translate-y-1/2"
          style={{ left: dragPreview.x, top: dragPreview.y }}
        >
          <div className="px-3 py-1.5 rounded-lg border border-accent/30 bg-surface/90 shadow-[0_8px_24px_rgba(0,0,0,0.18)] text-[12px] text-text-main backdrop-blur-sm opacity-95">
            {dragPreview.text}
          </div>
        </div>
      )}
      {contextMenu && (
        <div
          className="fixed z-[120] min-w-[170px] rounded-xl border border-border bg-surface shadow-[0_12px_30px_rgba(0,0,0,0.16)] p-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.target.kind === 'collection' && contextTargetCollection && (
            <>
              <button
                onClick={() => {
                  openRenameCollection(contextTargetCollection.id);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-2 text-[13px] text-text-main rounded-lg hover:bg-surface2"
              >
                重命名合集
              </button>
              <div
                className="relative"
                onMouseEnter={() => setContextSubmenu('add-source-to-collection')}
                onMouseLeave={() => setContextSubmenu(null)}
              >
                <button className="w-full text-left px-3 py-2 text-[13px] text-text-main rounded-lg hover:bg-surface2 flex items-center justify-between">
                  添加信息源
                  <ChevronRight size={13} />
                </button>
                {contextSubmenu === 'add-source-to-collection' && (
                  <div className="absolute left-full top-0 ml-1 min-w-[170px] rounded-xl border border-border bg-surface shadow-[0_12px_30px_rgba(0,0,0,0.16)] p-1">
                    {topLevelSources.length === 0 ? (
                      <div className="px-3 py-2 text-[12px] text-text3">暂无可添加源</div>
                    ) : (
                      topLevelSources.map(source => (
                        <button
                          key={source.id}
                          onClick={() => {
                            moveSourceToCollection(source.id, contextTargetCollection.id);
                            setContextMenu(null);
                            setContextSubmenu(null);
                          }}
                          className="w-full text-left px-3 py-2 text-[13px] text-text-main rounded-lg hover:bg-surface2"
                        >
                          {source.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  // 取消合集：将所有子源移到顶层，删除合集
                  setSourceEntries(prev => {
                    const collectionIndex = prev.findIndex(entry => entry.type === 'collection' && entry.id === contextTargetCollection.id);
                    if (collectionIndex < 0) return prev;
                    const collection = prev[collectionIndex] as CollectionEntry;
                    const working = [...prev];
                    working.splice(collectionIndex, 1);
                    // 将子源插入到原合集位置
                    working.splice(collectionIndex, 0, ...collection.children);
                    return working;
                  });
                  setContextMenu(null);
                  showToast('已取消合集');
                }}
                className="w-full text-left px-3 py-2 text-[13px] text-red-500 rounded-lg hover:bg-surface2"
              >
                取消合集
              </button>
            </>
          )}
          {contextMenu.target.kind === 'source' && contextTargetSource && (
            <>
              <button
                onClick={() => {
                  openRenameSource(contextTargetSource.id);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-2 text-[13px] text-text-main rounded-lg hover:bg-surface2"
              >
                重命名信息源
              </button>
              {contextSourceInCollectionId ? (
                <button
                  onClick={() => {
                    removeSourceFromCollection(contextTargetSource.id, contextSourceInCollectionId);
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-2 text-[13px] text-text-main rounded-lg hover:bg-surface2"
                >
                  移出合集
                </button>
              ) : (
                <div
                  className="relative"
                  onMouseEnter={() => setContextSubmenu('move-source-to-collection')}
                  onMouseLeave={() => setContextSubmenu(null)}
                >
                  <button className="w-full text-left px-3 py-2 text-[13px] text-text-main rounded-lg hover:bg-surface2 flex items-center justify-between">
                    添加进合集
                    <ChevronRight size={13} />
                  </button>
                  {contextSubmenu === 'move-source-to-collection' && (
                    <div className="absolute left-full top-0 ml-1 min-w-[170px] rounded-xl border border-border bg-surface shadow-[0_12px_30px_rgba(0,0,0,0.16)] p-1">
                      {collections.length === 0 ? (
                        <div className="px-3 py-2 text-[12px] text-text3">暂无合集</div>
                      ) : (
                        collections.map(collection => (
                          <button
                            key={collection.id}
                            onClick={() => {
                              moveSourceToCollection(contextTargetSource.id, collection.id);
                              setContextMenu(null);
                              setContextSubmenu(null);
                            }}
                            className="w-full text-left px-3 py-2 text-[13px] text-text-main rounded-lg hover:bg-surface2"
                          >
                            {collection.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="my-1 border-t border-border" />
              <button
                onClick={async () => {
                  const confirmed = window.confirm(`确定要删除信息源「${contextTargetSource.name}」吗？`);
                  if (!confirmed) return;
                  setContextMenu(null);
                  await deleteSource(contextTargetSource.id);
                }}
                className="w-full text-left px-3 py-2 text-[13px] text-red-500 rounded-lg hover:bg-surface2 flex items-center gap-2"
              >
                <Trash2 size={13} />
                删除
              </button>
            </>
          )}
        </div>
      )}
      {renameDialog && (
        <div className="fixed inset-0 z-[131] bg-black/30 flex items-center justify-center p-4">
          <div className="w-full max-w-[360px] rounded-2xl border border-border bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2)]">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div className="text-[15px] font-semibold text-text-main">
                {renameDialog.kind === 'collection' ? '重命名合集' : '重命名信息源'}
              </div>
              <button
                onClick={closeRenameDialog}
                className="w-7 h-7 rounded-md hover:bg-surface2 text-text3 flex items-center justify-center"
              >
                <X size={14} />
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void submitRename();
                  }
                }}
                placeholder="请输入新名称"
                className="w-full px-3 py-2 rounded-lg border border-border bg-bg text-[13px] text-text-main outline-none focus:border-accent"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={closeRenameDialog}
                  className="flex-1 px-3 py-2 rounded-lg border border-border text-[13px] text-text-main hover:bg-surface2 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => void submitRename()}
                  className="flex-1 px-3 py-2 rounded-lg bg-accent text-white text-[13px] font-medium hover:opacity-90 transition-opacity"
                >
                  确认
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showAddSourceModal && (
        <div className="fixed inset-0 z-[130] bg-black/30 flex items-center justify-center p-4">
          <div className="w-full max-w-[360px] rounded-2xl border border-border bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2)]">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div className="text-[15px] font-semibold text-text-main">添加信息源</div>
              <button
                onClick={closeAddSourceModal}
                className="w-7 h-7 rounded-md hover:bg-surface2 text-text3 flex items-center justify-center"
              >
                <X size={14} />
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <div className="text-[12px] text-text3">
                支持关键词、URL、RSS 订阅源和 RSSHub 路由
              </div>
              <input
                value={newSourceInput}
                onChange={(event) => setNewSourceInput(event.target.value)}
                placeholder="输入关键词、URL、RSS 或 RSSHub 路由"
                className="w-full px-3 py-2 rounded-lg border border-border bg-bg text-[13px] text-text-main outline-none focus:border-accent"
              />
              <input
                value={newSourceAlias}
                onChange={(event) => setNewSourceAlias(event.target.value)}
                placeholder="信息源名称（可选，不填自动生成）"
                className="w-full px-3 py-2 rounded-lg border border-border bg-bg text-[13px] text-text-main outline-none focus:border-accent"
              />
              <button
                onClick={addSource}
                className="w-full mt-1 px-3 py-2 rounded-lg bg-accent text-white text-[13px] font-medium hover:opacity-90 transition-opacity"
              >
                添加信息源
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className="p-4 border-t border-border flex items-center justify-between shrink-0">
        {user ? (
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setShowProfileModal(true)}
              className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
            >
              {user.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt=""
                  className="w-6 h-6 rounded-full object-cover shrink-0"
                  onError={(e) => {
                    const el = e.currentTarget;
                    el.style.display = 'none';
                    el.nextElementSibling?.classList.remove('hidden');
                  }}
                />
              ) : null}
              <div className={`w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-[11px] font-medium shrink-0${user.avatar_url ? ' hidden' : ''}`}>
                {(user.nickname || user.email)[0].toUpperCase()}
              </div>
              <span className="text-[12px] text-text2 truncate">
                {user.nickname || user.email.split('@')[0]}
              </span>
            </button>
            <button
              onClick={() => void logout()}
              className="p-1 rounded-md text-text3 hover:text-red-500 hover:bg-surface2 transition-colors shrink-0"
              title="登出"
            >
              <LogOut size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => loginAndDo(() => {})}
            className="flex items-center gap-1.5 text-[12px] text-accent hover:opacity-80 transition-opacity"
          >
            <LogIn size={14} />
            登录 / 注册
          </button>
        )}
        <button onClick={toggleTheme} className="p-2 rounded-md text-text2 hover:bg-surface2 transition-colors shrink-0">
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </nav>
  );
};

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
  fullWidth?: boolean;
}> = ({ active, onClick, children, badge, fullWidth }) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-4 py-2 md:py-1.5 rounded-md text-[14px] font-medium transition-colors flex items-center gap-2",
        fullWidth && "w-full justify-between",
        active ? "bg-accent-light text-accent" : "text-text2 hover:bg-surface2"
      )}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="bg-accent text-white text-[11px] rounded-full px-1.5 min-w-[18px] h-[18px] flex items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  );
};
