import React, { useState, useEffect, useRef } from 'react';
import { X, Mail, ArrowLeft, Loader2 } from 'lucide-react';
import { cn } from './Nav';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: { id: number; email: string }) => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && step === 'email') {
      setTimeout(() => emailInputRef.current?.focus(), 100);
    }
    if (isOpen && step === 'code') {
      setTimeout(() => codeInputRef.current?.focus(), 100);
    }
  }, [isOpen, step]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (!isOpen) {
      setStep('email');
      setEmail('');
      setCode('');
      setError('');
      setLoading(false);
      setCountdown(0);
    }
  }, [isOpen]);

  const handleSendCode = async () => {
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('请输入有效的邮箱地址');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '发送失败');
        return;
      }
      setStep('code');
      setCountdown(60);
    } catch {
      setError('网络错误，请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '发送失败');
        return;
      }
      setCountdown(60);
    } catch {
      setError('网络错误，请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    const trimmedCode = code.trim();
    if (!trimmedCode || trimmedCode.length !== 6) {
      setError('请输入 6 位验证码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: trimmedCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '验证失败');
        return;
      }
      onSuccess(data.user);
    } catch {
      setError('网络错误，请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[140] bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-[380px] rounded-2xl border border-border bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            {step === 'code' && (
              <button
                onClick={() => { setStep('email'); setCode(''); setError(''); }}
                className="w-7 h-7 rounded-md hover:bg-surface2 text-text3 flex items-center justify-center"
              >
                <ArrowLeft size={14} />
              </button>
            )}
            <div className="text-[15px] font-semibold text-text-main">
              {step === 'email' ? '登录 / 注册' : '输入验证码'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-surface2 text-text3 flex items-center justify-center"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {step === 'email' ? (
            <>
              <p className="text-[13px] text-text3 mb-4">输入你的邮箱，我们会发送一个验证码</p>
              <div className="relative mb-3">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') void handleSendCode(); }}
                  placeholder="your@email.com"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
              </div>
              {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
              <button
                onClick={() => void handleSendCode()}
                disabled={loading}
                className={cn(
                  "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2",
                  loading
                    ? "bg-accent/60 text-white cursor-wait"
                    : "bg-accent text-white hover:opacity-90"
                )}
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? '发送中...' : '发送验证码'}
              </button>
            </>
          ) : (
            <>
              <p className="text-[13px] text-text3 mb-1">验证码已发送至</p>
              <p className="text-[14px] text-text-main font-medium mb-4">{email}</p>
              <input
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={e => { setCode(e.target.value.replace(/\D/g, '')); setError(''); }}
                onKeyDown={e => { if (e.key === 'Enter') void handleVerify(); }}
                placeholder="输入 6 位验证码"
                className="w-full px-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main text-center tracking-[6px] outline-none focus:border-accent transition-colors mb-3"
              />
              {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
              <button
                onClick={() => void handleVerify()}
                disabled={loading}
                className={cn(
                  "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2 mb-3",
                  loading
                    ? "bg-accent/60 text-white cursor-wait"
                    : "bg-accent text-white hover:opacity-90"
                )}
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? '验证中...' : '验证并登录'}
              </button>
              <button
                onClick={() => void handleResend()}
                disabled={countdown > 0 || loading}
                className="w-full text-[13px] text-text3 hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {countdown > 0 ? `${countdown} 秒后可重新发送` : '重新发送验证码'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
