import React, { useState, useEffect, useRef } from 'react';
import { X, Camera, Download, Loader2, Mail, Trash2 } from 'lucide-react';
import { cn } from './Nav';
import { useAppContext } from '../context/AppContext';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ProfileModal: React.FC<ProfileModalProps> = ({ isOpen, onClose }) => {
  const { user, updateProfile, updateAvatar, showToast, logout } = useAppContext();
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && user) {
      setNickname(user.nickname || '');
      setError('');
      setSaving(false);
      setUploadingAvatar(false);
      setExporting(false);
      setDeleting(false);
      setShowDeleteConfirm(false);
      setDeleteConfirmation('');
      setDeletePassword('');
    }
  }, [isOpen, user]);

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setError('图片大小不能超过 2MB');
      return;
    }

    setError('');
    setUploadingAvatar(true);
    try {
      await updateAvatar(file);
      showToast('头像已更新');
    } catch (err: any) {
      setError(err?.message || '头像上传失败');
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSave = async () => {
    const trimmed = nickname.trim();
    if (!trimmed) {
      setError('昵称不能为空');
      return;
    }
    if (trimmed.length > 30) {
      setError('昵称不能超过 30 个字符');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await updateProfile(trimmed);
      showToast('个人信息已更新');
      onClose();
    } catch (err: any) {
      setError(err?.message || '保存失败，请稍后再试');
    } finally {
      setSaving(false);
    }
  };

  const readApiError = async (response: Response, fallback: string) => {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    return payload?.error || fallback;
  };

  const handleExport = async () => {
    setError('');
    setExporting(true);
    try {
      const response = await fetch('/api/account/export');
      if (!response.ok) throw new Error(await readApiError(response, '数据导出失败'));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `atomflow-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast('数据导出已生成');
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据导出失败');
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteAccount = async () => {
    setError('');
    setDeleting(true);
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: deleteConfirmation, password: deletePassword }),
      });
      if (!response.ok) throw new Error(await readApiError(response, '账户注销失败'));
      await logout();
      onClose();
      showToast('账户及关联数据已删除');
    } catch (err) {
      setError(err instanceof Error ? err.message : '账户注销失败');
    } finally {
      setDeleting(false);
    }
  };

  if (!isOpen || !user) return null;

  const avatarLetter = (user.nickname || user.email)[0].toUpperCase();

  return (
    <div className="fixed inset-0 z-[140] bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-[380px] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border border-border bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="text-[15px] font-semibold text-text-main">个人设置</div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-surface2 text-text3 flex items-center justify-center"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {/* Avatar */}
          <div className="flex justify-center mb-5">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
              className="relative group"
            >
              {user.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt=""
                  className="w-16 h-16 rounded-full object-cover"
                  onError={(e) => {
                    const el = e.currentTarget;
                    el.style.display = 'none';
                    el.nextElementSibling?.classList.remove('hidden');
                  }}
                />
              ) : null}
              <div className={`w-16 h-16 rounded-full bg-accent text-white flex items-center justify-center text-[22px] font-semibold${user.avatar_url ? ' hidden' : ''}`}>
                {avatarLetter}
              </div>
              <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                {uploadingAvatar ? (
                  <Loader2 size={20} className="text-white animate-spin" />
                ) : (
                  <Camera size={20} className="text-white" />
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={e => void handleAvatarChange(e)}
              />
            </button>
          </div>

          {/* Nickname */}
          <label className="block text-[12px] text-text3 mb-1.5">昵称</label>
          <input
            type="text"
            value={nickname}
            onChange={e => { setNickname(e.target.value); setError(''); }}
            onKeyDown={e => { if (e.key === 'Enter') void handleSave(); }}
            maxLength={30}
            placeholder="输入你的昵称"
            className="w-full px-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors mb-3"
          />

          {/* Email (read-only) */}
          <label className="block text-[12px] text-text3 mb-1.5">邮箱</label>
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-surface2 text-[14px] text-text3 mb-3">
            <Mail size={14} className="shrink-0" />
            <span className="truncate">{user.email}</span>
          </div>

          {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}

          {/* Save button */}
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className={cn(
              "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2",
              saving
                ? "bg-accent/60 text-white cursor-wait"
                : "bg-accent text-white hover:opacity-90"
            )}
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            {saving ? '保存中...' : '保存'}
          </button>

          <div className="mt-5 border-t border-border pt-4">
            <button
              onClick={() => void handleExport()}
              disabled={exporting}
              className="w-full h-10 border border-border bg-surface text-text-main hover:bg-surface2 rounded-lg text-[13px] font-medium flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              {exporting ? '正在导出...' : '导出我的数据'}
            </button>

            {!showDeleteConfirm ? (
              <button
                onClick={() => { setShowDeleteConfirm(true); setError(''); }}
                className="w-full h-10 mt-2 text-red-600 hover:bg-red-50 rounded-lg text-[13px] font-medium flex items-center justify-center gap-2"
              >
                <Trash2 size={15} />
                注销账户
              </button>
            ) : (
              <div className="mt-3 border-t border-red-200 pt-3">
                <label className="block text-[12px] text-text3 mb-1.5">输入当前邮箱确认永久删除</label>
                <input
                  type="email"
                  value={deleteConfirmation}
                  onChange={event => setDeleteConfirmation(event.target.value)}
                  placeholder={user.email}
                  className="w-full px-3 py-2 rounded-lg border border-red-200 bg-bg text-[13px] text-text-main outline-none focus:border-red-500"
                />
                {user.has_password && (
                  <input
                    type="password"
                    value={deletePassword}
                    onChange={event => setDeletePassword(event.target.value)}
                    placeholder="当前密码"
                    className="w-full mt-2 px-3 py-2 rounded-lg border border-red-200 bg-bg text-[13px] text-text-main outline-none focus:border-red-500"
                  />
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmation(''); setDeletePassword(''); }}
                    disabled={deleting}
                    className="flex-1 h-9 border border-border rounded-lg text-[13px] text-text2 hover:bg-surface2"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void handleDeleteAccount()}
                    disabled={deleting || deleteConfirmation.trim().toLowerCase() !== user.email.toLowerCase() || Boolean(user.has_password && !deletePassword)}
                    className="flex-1 h-9 bg-red-600 text-white rounded-lg text-[13px] font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {deleting && <Loader2 size={14} className="animate-spin" />}
                    永久删除
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
