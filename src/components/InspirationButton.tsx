import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Lightbulb, Mic, X, Send } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { useSpeechRecognition } from '../utils/useSpeechRecognition';
import { AtomCard } from '../types';

interface InspirationButtonProps {
  articleTitle: string;
  articleId?: number;
  savedArticleId?: number;
  compact?: boolean;
  label?: string;
}

export function InspirationButton({ articleTitle, articleId, savedArticleId, compact, label = '记录灵感' }: InspirationButtonProps) {
  const { addCard, showToast, user, loginAndDo } = useAppContext();
  const { isRecording, transcript, isSupported: micSupported, error, startRecording, stopRecording, resetTranscript } = useSpeechRecognition();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [showMicNotice, setShowMicNotice] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync voice transcript into textarea
  useEffect(() => {
    if (transcript) {
      setText(prev => {
        // If user had typed something, append voice after a space
        if (prev && !prev.endsWith(' ') && !prev.endsWith('\n')) {
          return prev + ' ' + transcript;
        }
        return prev + transcript;
      });
    }
  }, [transcript]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  // Auto-focus textarea when panel opens
  useEffect(() => {
    if (open && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [open]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = useCallback(() => {
    if (!user) {
      loginAndDo(() => {});
      return;
    }
    setOpen(true);
    setText('');
    resetTranscript();
  }, [user, loginAndDo, resetTranscript]);

  const handleClose = useCallback(() => {
    if (isRecording) stopRecording();
    resetTranscript();
    setOpen(false);
    setText('');
  }, [isRecording, stopRecording, resetTranscript]);

  const handleMicToggle = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      setShowMicNotice(true);
    }
  }, [isRecording, stopRecording]);

  const confirmMicStart = useCallback(() => {
    setShowMicNotice(false);
    resetTranscript();
    startRecording();
  }, [resetTranscript, startRecording]);

  const handleSave = useCallback(async () => {
    const content = text.trim();
    if (!content) {
      showToast('请输入灵感内容');
      return;
    }
    setSaving(true);
    try {
      const card: AtomCard = {
        id: '',
        type: '灵感',
        content,
        tags: ['灵感'],
        articleTitle,
        articleId,
        origin: 'manual',
        savedArticleId,
      };
      const succeeded = await addCard(card);
      if (!succeeded) {
        showToast('保存失败，请重试');
        return;
      }
      showToast('灵感已记录 ✨');
      handleClose();
    } catch {
      showToast('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }, [text, addCard, showToast, articleTitle, articleId, savedArticleId, handleClose]);

  // Ctrl+Enter to save
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && text.trim()) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      handleClose();
    }
  }, [handleSave, handleClose, text]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={handleOpen}
        title={label}
        className={`px-3 py-1.5 rounded-lg text-[12px] sm:text-[13px] font-medium flex items-center gap-1 transition-colors border border-border text-text2 hover:bg-surface2`}
      >
        <Lightbulb size={14} />
        {compact ? (
          <span className="hidden sm:inline">{label}</span>
        ) : (
          <span>{label}</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[320px] sm:w-[360px] bg-surface rounded-xl shadow-lg border border-border p-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-text-main flex items-center gap-1.5">
              <Lightbulb size={15} className="text-yellow-500" />
              {label}
            </span>
            <button onClick={handleClose} className="text-text3 hover:text-text-main p-0.5 rounded">
              <X size={16} />
            </button>
          </div>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="写下你此刻的灵感..."
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main placeholder:text-text3 focus:outline-none focus:ring-1 focus:ring-accent"
          />

          {isRecording && (
            <div className="mt-1.5 text-xs text-red-500 animate-pulse flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
              正在听写...
            </div>
          )}

          {showMicNotice && !isRecording && (
            <div className="mt-2 rounded-lg border border-border bg-surface2 p-2 text-[11px] leading-4 text-text2">
              <p>开始后，音频将实时发送给当前实例配置的语音识别服务；停止录音后不再发送。</p>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setShowMicNotice(false)} className="px-2 py-1 text-text3 hover:text-text-main">取消</button>
                <button type="button" onClick={confirmMicStart} className="rounded-md bg-accent px-2 py-1 font-medium text-white">开始听写</button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-1">
              {micSupported && (
                <button
                  onClick={handleMicToggle}
                  title={isRecording ? '停止听写' : '语音输入'}
                  className={`p-1.5 rounded-lg transition-colors ${
                    isRecording
                      ? 'bg-red-50 dark:bg-red-900/20 text-red-500'
                      : 'text-text3 hover:text-text-main hover:bg-surface2'
                  }`}
                >
                  <Mic size={16} />
                </button>
              )}
              <span className="text-[11px] text-text3 ml-1">Ctrl+Enter 保存</span>
            </div>
            <button
              onClick={handleSave}
              disabled={saving || !text.trim()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={13} />
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
