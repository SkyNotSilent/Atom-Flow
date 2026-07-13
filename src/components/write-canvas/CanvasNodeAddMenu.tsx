import React, { useState } from 'react';
import { FilePlus2, Plus, Sparkles } from 'lucide-react';

export type CanvasNodeAction = 'new-child' | 'ai-decompose' | 'create-document';

type CanvasNodeAddMenuProps = {
  nodeId: number;
};

const stopCanvasInteraction = (event: React.SyntheticEvent) => {
  event.stopPropagation();
};

export const CanvasNodeAddMenu: React.FC<CanvasNodeAddMenuProps> = ({ nodeId }) => {
  const [isOpen, setIsOpen] = useState(false);

  const dispatchAction = (action: CanvasNodeAction) => {
    window.dispatchEvent(new CustomEvent('atomflow-canvas-node-action', { detail: { nodeId, action } }));
    setIsOpen(false);
  };

  return (
    <div
      className="absolute bottom-2 right-2 z-10"
      onPointerDown={stopCanvasInteraction}
      onPointerMove={stopCanvasInteraction}
      onPointerUp={stopCanvasInteraction}
      onDoubleClick={stopCanvasInteraction}
    >
      {isOpen ? (
        <div className="absolute bottom-9 right-0 w-32 rounded-[6px] border border-[#DAD8D2] bg-white p-1 shadow-[0_10px_24px_rgba(35,40,48,0.16)]">
          <ActionButton icon={<Plus size={12} />} onClick={() => dispatchAction('new-child')}>新建子节点</ActionButton>
          <ActionButton icon={<Sparkles size={12} />} onClick={() => dispatchAction('ai-decompose')}>AI 拆解</ActionButton>
          <ActionButton icon={<FilePlus2 size={12} />} onClick={() => dispatchAction('create-document')}>创建作品</ActionButton>
        </div>
      ) : null}
      <button
        type="button"
        aria-label="节点操作"
        aria-expanded={isOpen}
        onClick={event => {
          event.stopPropagation();
          setIsOpen(open => !open);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-[5px] border border-[#C9D7E9] bg-white text-[#2767B4] shadow-sm hover:bg-[#EDF5FF]"
      >
        <Plus size={14} />
      </button>
    </div>
  );
};

const ActionButton: React.FC<{ icon: React.ReactNode; onClick: () => void; children: React.ReactNode }> = ({ icon, onClick, children }) => (
  <button
    type="button"
    onClick={event => {
      event.stopPropagation();
      onClick();
    }}
    className="flex w-full items-center gap-1.5 rounded-[4px] px-2 py-1.5 text-left text-[10px] text-[#42474E] hover:bg-[#EEF4FC] hover:text-[#185ABD]"
  >
    {icon}
    {children}
  </button>
);
