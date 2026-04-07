import React, { useState, useEffect, useRef } from 'react';
import { X, Camera, Loader2, Mail } from 'lucide-react';
import { cn } from './Nav';
import { useAppContext } from '../context/AppContext';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ProfileModal: React.FC<ProfileModalProps> = ({ isOpen, onClose }) => {
  const { user, updateProfile, updateAvatar, showToast } = useAppContext();
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && user) {
      setNickname(user.nickname || '');
      setError('');
      setSaving(false);
      setUploadingAvatar(false);
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

  if (!isOpen || !user) return null;

  const avatarLetter = (user.nickname || user.email)[0].toUpperCase();

  return (
    <div className="fixed inset-0 z-[140] bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-[380px] rounded-2xl border border-border bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2)]"
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
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-accent text-white flex items-center justify-center text-[22px] font-semibold">
                  {avatarLetter}
                </div>
              )}
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
        </div>
      </div>
    </div>
  );
};
