import React, { useEffect, useMemo, useState } from 'react';
import { Bot, FileSearch, Link2, Pin, PinOff, Sparkles, SquareMousePointer, X } from 'lucide-react';
import type { Article, SavedArticle, WriteAgentSkill, WriteCanvasNode, WriteCanvasProject, WriteSkillSelection } from '../../types';
import { ArticleReader, type CitationAction, type CitationCapture } from '../ReaderModal';
import { cn } from '../Nav';

export type CanvasContextTab = 'assistant' | 'original' | 'node' | 'skills';

type CanvasContextRailProps = {
  nodes: WriteCanvasNode[];
  selectedNode: WriteCanvasNode | null;
  assistantNode: WriteCanvasNode | null;
  project: WriteCanvasProject | null;
  skills: WriteAgentSkill[];
  getArticleForNode: (node: WriteCanvasNode | null) => Article | null;
  renderInspectorPanel: (node: WriteCanvasNode | null, emptyMessage: string) => React.ReactNode;
  onCitationCapture: (capture: CitationCapture, action: CitationAction, targetAgentNode: WriteCanvasNode | null) => void | Promise<void>;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  onSaveProjectSkills: (selection: WriteSkillSelection) => void | Promise<void>;
  onSaveAgentSkills: (node: WriteCanvasNode, selection: WriteSkillSelection) => void | Promise<void>;
  readOnly?: boolean;
};

const tabItems: Array<{ value: CanvasContextTab; label: string; icon: React.ReactNode }> = [
  { value: 'assistant', label: '助手', icon: <Bot size={13} /> },
  { value: 'original', label: '原文', icon: <FileSearch size={13} /> },
  { value: 'node', label: '节点', icon: <SquareMousePointer size={13} /> },
  { value: 'skills', label: 'Skills', icon: <Sparkles size={13} /> },
];

const preferredTabForNode = (node: WriteCanvasNode | null): CanvasContextTab => {
  if (!node) return 'assistant';
  if (node.kind === 'agent') return 'assistant';
  if (node.kind === 'saved_article' || node.kind === 'citation' || node.kind === 'podcast_episode') return 'original';
  return 'node';
};

export const CanvasContextRail: React.FC<CanvasContextRailProps> = ({
  nodes,
  selectedNode,
  assistantNode,
  project,
  skills,
  getArticleForNode,
  renderInspectorPanel,
  onCitationCapture,
  mobileOpen = false,
  onMobileClose,
  onSaveProjectSkills,
  onSaveAgentSkills,
  readOnly = false,
}) => {
  const [tab, setTab] = useState<CanvasContextTab>(() => preferredTabForNode(selectedNode));
  const [pinnedContext, setPinnedContext] = useState<{
    projectId: number | null;
    selectedNodeId: number | null;
    assistantNodeId: number | null;
  } | null>(null);
  const pinned = Boolean(pinnedContext);
  const activeProject = project;
  const activeSelectedNode = pinnedContext
    ? nodes.find(node => node.id === pinnedContext.selectedNodeId) || null
    : selectedNode;
  const activeAssistantNode = pinnedContext
    ? nodes.find(node => node.id === pinnedContext.assistantNodeId) || null
    : assistantNode;
  const activeArticle = getArticleForNode(activeSelectedNode);
  const activeAssistantPanel = renderInspectorPanel(
    activeAssistantNode,
    '画布中还没有写作 Agent。点击“添加节点”创建一个 Agent。',
  );
  const activeNodePanel = renderInspectorPanel(
    activeSelectedNode,
    '选择一个业务节点查看详情与连接操作。',
  );
  const [resolvedArticle, setResolvedArticle] = useState<Article | null>(activeArticle);
  const [articleLoadError, setArticleLoadError] = useState(false);

  useEffect(() => {
    if (!pinned) setTab(preferredTabForNode(selectedNode));
  }, [pinned, selectedNode?.id]);

  useEffect(() => {
    if (pinnedContext && pinnedContext.projectId !== (project?.id ?? null)) setPinnedContext(null);
  }, [pinnedContext, project?.id]);

  useEffect(() => {
    setResolvedArticle(activeArticle);
    setArticleLoadError(false);
    if (!activeArticle?.saved || activeArticle.fullFetched || activeArticle.content) return;
    const controller = new AbortController();
    const requestedArticleId = activeArticle.id;
    void fetch(`/api/saved-articles/${requestedArticleId}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('saved article unavailable');
      const full = await response.json() as SavedArticle;
      if (controller.signal.aborted) return;
      setResolvedArticle(current => current?.id === requestedArticleId ? {
        ...current,
        source: full.source || current.source,
        sourceIcon: full.sourceIcon || current.sourceIcon,
        topic: full.topic || current.topic,
        title: full.title || current.title,
        excerpt: full.excerpt || current.excerpt,
        citationContext: full.citationContext || current.citationContext,
        sourceImages: full.sourceImages || current.sourceImages,
        content: full.content || '',
        url: full.url || current.url,
        audioUrl: full.audioUrl || current.audioUrl,
        audioDuration: full.audioDuration || current.audioDuration,
        fullFetched: true,
      } : current);
    }).catch(error => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setArticleLoadError(true);
      setResolvedArticle(current => current?.id === requestedArticleId ? { ...current, fullFetched: true } : current);
    });
    return () => controller.abort();
  }, [activeArticle?.content, activeArticle?.fullFetched, activeArticle?.id, activeArticle?.saved, activeArticle?.url]);

  return (
    <>
      {mobileOpen ? <button type="button" aria-label="关闭上下文栏" onClick={onMobileClose} className="fixed inset-0 z-[89] bg-black/30 xl:hidden" /> : null}
      <aside
      data-testid="canvas-context-rail"
      className={cn(
        'atomflow-write-context fixed inset-y-0 right-0 z-[90] flex min-h-0 w-[min(100vw,420px)] shrink-0 flex-col overflow-hidden border-l border-[#D9D4CB] bg-[#FCFAF6] shadow-2xl transition-transform xl:static xl:w-[var(--write-context-width,420px)] xl:translate-x-0 xl:shadow-none',
        mobileOpen ? 'atomflow-write-context-mobile-open translate-x-0' : 'translate-x-full pointer-events-none xl:pointer-events-auto',
      )}
    >
      <header className="border-b border-[#E2DDD4] bg-[#F8F4ED] px-3 pb-2 pt-3">
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#9B9185]">上下文工作台</div>
            <div className="mt-1 truncate text-[11px] text-[#645D55]">{activeSelectedNode?.title || activeProject?.name || '选择画布节点开始'}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPinnedContext(current => current ? null : {
                projectId: project?.id ?? null,
                selectedNodeId: selectedNode?.id ?? null,
                assistantNodeId: assistantNode?.id ?? null,
              })}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md border px-2 text-[10px]',
                pinned
                  ? 'border-[#9BB8D8] bg-[#E8F0FA] text-[#245F9F]'
                  : 'border-[#D9D2C8] bg-white text-[#7C746B] hover:text-[#245F9F]',
              )}
              title={pinned ? '取消固定，随选择自动切换' : '固定当前上下文'}
            >
              {pinned ? <Pin size={12} /> : <PinOff size={12} />}
              {pinned ? '已固定' : '固定'}
            </button>
            <button type="button" onClick={onMobileClose} className="flex h-8 w-8 items-center justify-center rounded-md text-[#756D64] hover:bg-[#E9E3D9] xl:hidden" aria-label="关闭上下文栏"><X size={15} /></button>
          </div>
        </div>
        <nav className="grid grid-cols-4 gap-1 rounded-lg bg-[#ECE7DE] p-1" aria-label="画布上下文">
          {tabItems.map(item => (
            <button
              key={item.value}
              type="button"
              onClick={() => setTab(item.value)}
              className={cn(
                'flex min-w-0 items-center justify-center gap-1 rounded-md px-1.5 py-2 text-[10px] transition-colors',
                tab === item.value
                  ? 'bg-white font-semibold text-[#245F9F] shadow-sm'
                  : 'text-[#746D64] hover:text-[#302C28]',
              )}
            >
              {item.icon}<span className="truncate">{item.label}</span>
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'assistant' ? activeAssistantPanel : null}
        {tab === 'node' ? activeNodePanel : null}
        {tab === 'original' ? (
          resolvedArticle ? (
            <div className="relative h-full min-h-0">
              {articleLoadError ? (
                <div className="absolute inset-x-3 top-3 z-20 rounded-lg border border-[#E4C7A4] bg-[#FFF7EA] px-3 py-2 text-[10px] text-[#805C31]">
                  全文加载失败，仍可查看摘要并打开原文。
                </div>
              ) : null}
              <ArticleReader
                article={resolvedArticle}
                variant="compact"
                audio={false}
                onCitationCapture={(capture, action) => onCitationCapture(capture, action, activeAssistantNode)}
              />
            </div>
          ) : activeSelectedNode?.kind === 'podcast_episode' ? (
            <PodcastNodeOriginal node={activeSelectedNode} />
          ) : (
            <RailEmpty icon={<FileSearch size={24} />} title="选择文章或引用节点" description="原文、翻译与摘录会在这里打开。" />
          )
        ) : null}
        {tab === 'skills' ? (
          <SkillsPanel
            project={activeProject}
            selectedNode={activeSelectedNode}
            skills={skills}
            onSaveProjectSkills={onSaveProjectSkills}
            onSaveAgentSkills={onSaveAgentSkills}
            readOnly={readOnly}
          />
        ) : null}
      </div>
      </aside>
    </>
  );
};

const PodcastNodeOriginal: React.FC<{ node: WriteCanvasNode }> = ({ node }) => {
  const audioUrl = typeof node.meta?.audioUrl === 'string' ? node.meta.audioUrl : '';
  const sourceUrl = typeof node.meta?.sourceUrl === 'string' ? node.meta.sourceUrl : '';
  return (
    <div className="h-full overflow-y-auto px-5 py-6">
      <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#9A9084]">播客单集</div>
      <h2 className="mt-3 font-serif text-[20px] font-semibold leading-8 text-[#28241F]">{node.title}</h2>
      <p className="mt-4 whitespace-pre-wrap text-[12px] leading-6 text-[#665E56]">{node.summary || '暂无节目摘要。'}</p>
      <div className="mt-5 rounded-lg border border-[#DDD6CB] bg-white p-3 text-[11px] leading-5 text-[#746C63]">
        音频播放由应用级播放器接管；在写作页切换项目和模式不会创建第二个音频实例。
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {audioUrl ? <a href={audioUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-[#205FAD] px-3 py-2 text-[11px] font-medium text-white">真实音频</a> : <span className="rounded-md bg-[#EEE8DF] px-3 py-2 text-[11px] text-[#8A8177]">音频待生成</span>}
        {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-[#D8D1C6] bg-white px-3 py-2 text-[11px] text-[#4F4942]">原文入口</a> : null}
      </div>
    </div>
  );
};

const SkillsPanel: React.FC<{
  project: WriteCanvasProject | null;
  selectedNode: WriteCanvasNode | null;
  skills: WriteAgentSkill[];
  onSaveProjectSkills: (selection: WriteSkillSelection) => void | Promise<void>;
  onSaveAgentSkills: (node: WriteCanvasNode, selection: WriteSkillSelection) => void | Promise<void>;
  readOnly?: boolean;
}> = ({ project, selectedNode, skills, onSaveProjectSkills, onSaveAgentSkills, readOnly = false }) => {
  const systemSkills = useMemo(() => skills.filter(skill => skill.isBaseline), [skills]);
  const configuredSkills = useMemo(() => {
    const snapshots = selectedNode?.agent ? selectedNode.agent.effectiveSkills : project?.effectiveSkills;
    const effectiveConfig = selectedNode?.agent
      ? selectedNode.agent.effectiveSkillConfig
      : project?.effectiveSkillConfig || project?.defaultSkillConfig;
    const ids = new Set<string>();
    for (const snapshot of snapshots || []) {
      if (snapshot.id !== undefined) ids.add(String(snapshot.id));
    }
    if (!snapshots?.length) {
      for (const id of effectiveConfig?.skillIds || []) ids.add(String(id));
      if (effectiveConfig?.primaryStyleSkillId !== undefined) ids.add(String(effectiveConfig.primaryStyleSkillId));
    }
    return skills.filter(skill => ids.has(String(skill.id)) && !skill.isBaseline);
  }, [project?.defaultSkillConfig, project?.effectiveSkillConfig, project?.effectiveSkills, selectedNode?.agent, skills]);

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div className="rounded-lg border border-[#DAD3C8] bg-white p-4">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-[#302C28]"><Sparkles size={14} className="text-[#2B68AB]" />本次有效 Skills</div>
        <p className="mt-2 text-[10px] leading-5 text-[#82796F]">系统基础始终生效；项目默认可被 Agent 的完整配置覆盖。生成时会把有效快照写入消息与文章元数据。</p>
      </div>
      <SkillConfigurationForm
        title="项目默认"
        skills={skills}
        value={{
          mode: 'override',
          inherit: false,
          skillIds: project?.defaultSkillConfig?.skillIds || [],
          primaryStyleSkillId: project?.defaultSkillConfig?.primaryStyleSkillId,
        }}
        disabled={!project || readOnly}
        onSave={onSaveProjectSkills}
      />
      {selectedNode?.agent ? (
        <SkillConfigurationForm
          key={`${selectedNode.id}:${selectedNode.agent.updatedAt}`}
          title={`${selectedNode.title} · Agent`}
          skills={skills}
          allowInherit
          disabled={readOnly}
          value={selectedNode.agent.skillConfig}
          onSave={selection => onSaveAgentSkills(selectedNode, selection)}
        />
      ) : null}
      <SkillGroup title="系统基础" skills={systemSkills} empty="系统会在运行时注入基础规范" />
      <SkillGroup title={selectedNode?.kind === 'agent' ? 'Agent / 项目配置' : '项目默认'} skills={configuredSkills} empty="尚未配置项目或 Agent Skill" />
      <div className="mt-5 rounded-lg border border-dashed border-[#D9D1C6] p-3 text-[10px] leading-5 text-[#8B8278]">
        完整创建、编辑和删除请切换左栏的 Skills 模式；魔法卡片与风格助手仍完整保留。
      </div>
    </div>
  );
};

const normalizeSkillSelection = (value: WriteSkillSelection, allowInherit: boolean): WriteSkillSelection => {
  const inherit = allowInherit && (value.inherit || value.mode === 'inherit');
  return inherit
    ? { mode: 'inherit', inherit: true, skillIds: [] }
    : {
      mode: 'override',
      inherit: false,
      skillIds: value.skillIds || [],
      ...(value.primaryStyleSkillId !== undefined ? { primaryStyleSkillId: value.primaryStyleSkillId } : {}),
    };
};

const SkillConfigurationForm: React.FC<{
  title: string;
  skills: WriteAgentSkill[];
  value: WriteSkillSelection;
  allowInherit?: boolean;
  disabled?: boolean;
  onSave: (selection: WriteSkillSelection) => void | Promise<void>;
}> = ({ title, skills, value, allowInherit = false, disabled = false, onSave }) => {
  const [draft, setDraft] = useState<WriteSkillSelection>(() => normalizeSkillSelection(value, allowInherit));
  const [saving, setSaving] = useState(false);
  const selectableSkills = useMemo(() => skills.filter(skill => !skill.isBaseline), [skills]);
  const selectedIds = new Set(draft.skillIds.map(String));
  const selectedStyleSkills = selectableSkills.filter(skill => skill.type === 'style' && selectedIds.has(String(skill.id)));

  useEffect(() => {
    setDraft(normalizeSkillSelection(value, allowInherit));
  }, [allowInherit, value.inherit, value.mode, value.primaryStyleSkillId, value.skillIds.join('|')]);

  const toggleSkill = (skillId: number | string) => {
    setDraft(current => {
      const selected = new Set(current.skillIds.map(String));
      const nextIds = selected.has(String(skillId))
        ? current.skillIds.filter(id => String(id) !== String(skillId))
        : [...current.skillIds, skillId];
      const primaryStyleSkillId = current.primaryStyleSkillId !== undefined
        && nextIds.some(id => String(id) === String(current.primaryStyleSkillId))
        ? current.primaryStyleSkillId
        : undefined;
      return { ...current, mode: 'override', inherit: false, skillIds: nextIds, primaryStyleSkillId };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(normalizeSkillSelection(draft, allowInherit));
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset disabled={disabled} className="mt-4 rounded-lg border border-[#DDD6CB] bg-[#FEFCF8] p-3 disabled:opacity-65">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold text-[#403A34]">{title}</div>
        {allowInherit ? (
          <label className="flex items-center gap-1.5 text-[10px] text-[#756D64]">
            <input
              type="checkbox"
              checked={draft.inherit}
              onChange={event => setDraft(current => event.target.checked
                ? { mode: 'inherit', inherit: true, skillIds: [] }
                : { ...current, mode: 'override', inherit: false })}
            />
            继承项目默认
          </label>
        ) : null}
      </div>
      {!draft.inherit ? (
        <>
          <div className="mt-3 max-h-44 space-y-1.5 overflow-y-auto pr-1">
            {selectableSkills.map(skill => (
              <label key={String(skill.id)} className="flex cursor-pointer items-start gap-2 rounded-md border border-[#E5DED3] bg-white px-2.5 py-2 hover:border-[#A9BED6]">
                <input type="checkbox" className="mt-0.5" checked={selectedIds.has(String(skill.id))} onChange={() => toggleSkill(skill.id)} />
                <span className="min-w-0">
                  <span className="block truncate text-[10px] font-medium text-[#4B443D]">{skill.name}</span>
                  <span className="mt-0.5 block text-[9px] text-[#92887D]">{skill.type === 'style' ? '风格' : skill.type}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="mt-3 block text-[10px] text-[#756D64]">
            主风格 Skill
            <select
              value={draft.primaryStyleSkillId === undefined ? '' : String(draft.primaryStyleSkillId)}
              onChange={event => {
                const skill = selectedStyleSkills.find(item => String(item.id) === event.target.value);
                setDraft(current => ({ ...current, primaryStyleSkillId: skill?.id }));
              }}
              className="mt-1.5 h-8 w-full rounded-md border border-[#DAD2C7] bg-white px-2 text-[10px] text-[#4F4841] outline-none focus:border-[#78A2D0]"
            >
              <option value="">{selectedStyleSkills.length > 0 ? '自动使用首个已选风格' : '使用系统默认风格'}</option>
              {selectedStyleSkills.map(skill => <option key={String(skill.id)} value={String(skill.id)}>{skill.name}</option>)}
            </select>
          </label>
        </>
      ) : <div className="mt-3 rounded-md bg-[#EEE9E1] px-3 py-3 text-[10px] text-[#81786E]">当前 Agent 会完整继承项目默认 Skills。</div>}
      <button type="button" disabled={disabled || saving} onClick={() => { void save(); }} className="mt-3 w-full rounded-md bg-[#235F9F] px-3 py-2 text-[10px] font-medium text-white disabled:opacity-50">{saving ? '保存中…' : '保存配置'}</button>
    </fieldset>
  );
};

const SkillGroup: React.FC<{ title: string; skills: WriteAgentSkill[]; empty: string }> = ({ title, skills, empty }) => (
  <section className="mt-5">
    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#998F83]">{title}</div>
    <div className="space-y-2">
      {skills.length > 0 ? skills.map(skill => (
        <div key={String(skill.id)} className="rounded-lg border border-[#DED7CC] bg-[#FEFCF8] px-3 py-3">
          <div className="flex items-start gap-2">
            <Link2 size={12} className="mt-0.5 shrink-0 text-[#3B71AA]" />
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-[#403A34]">{skill.name}</div>
              <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-[#887F75]">{skill.description || skill.prompt}</div>
            </div>
          </div>
        </div>
      )) : <div className="rounded-lg bg-[#EEE9E1] px-3 py-4 text-center text-[10px] text-[#8C8379]">{empty}</div>}
    </div>
  </section>
);

const RailEmpty: React.FC<{ icon: React.ReactNode; title: string; description: string }> = ({ icon, title, description }) => (
  <div className="flex h-full flex-col items-center justify-center px-8 text-center text-[#8C8379]">
    {icon}
    <div className="mt-3 text-[12px] font-semibold text-[#5E574F]">{title}</div>
    <div className="mt-1 text-[10px] leading-5">{description}</div>
  </div>
);
