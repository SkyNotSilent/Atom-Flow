import React, { useState, useEffect, useRef } from 'react';
import { X, Mail, ArrowLeft, Loader2, Lock, Eye, EyeOff } from 'lucide-react';
import { cn } from './Nav';
import { User } from '../types';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: User) => void;
}

type Mode = 'choose' | 'email-code' | 'password-login' | 'password-register';

export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [mode, setMode] = useState<Mode>('choose');
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (mode === 'email-code' && step === 'form') {
      setTimeout(() => emailInputRef.current?.focus(), 100);
    }
    if ((mode === 'email-code' && step === 'code') || (mode === 'password-register' && step === 'code')) {
      setTimeout(() => codeInputRef.current?.focus(), 100);
    }
    if (mode === 'password-login' || mode === 'password-register') {
      setTimeout(() => emailInputRef.current?.focus(), 100);
    }
  }, [isOpen, mode, step]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (!isOpen) {
      setMode('choose');
      setStep('form');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setCode('');
      setError('');
      setLoading(false);
      setCountdown(0);
      setShowPassword(false);
    }
  }, [isOpen]);

  const goBack = () => {
    setError('');
    if (step === 'code') {
      setStep('form');
      setCode('');
      return;
    }
    setMode('choose');
    setPassword('');
    setConfirmPassword('');
  };

  // --- Email code flow ---
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
      if (!res.ok) { setError(data.error || '发送失败'); return; }
      setStep('code');
      setCountdown(60);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  const handleResend = async () => {
    if (countdown > 0) return;
    setError('');
    setLoading(true);
    try {
      const endpoint = mode === 'password-register' ? '/api/auth/register' : '/api/auth/send-code';
      const body = mode === 'password-register'
        ? { email: email.trim(), password }
        : { email: email.trim() };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '发送失败'); return; }
      setCountdown(60);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  const handleVerifyCode = async () => {
    const trimmedCode = code.trim();
    if (!trimmedCode || trimmedCode.length !== 6) {
      setError('请输入 6 位验证码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const endpoint = mode === 'password-register' ? '/api/auth/register/verify' : '/api/auth/verify';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: trimmedCode }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '验证失败'); return; }
      onSuccess(data.user);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  // --- Password login ---
  const handlePasswordLogin = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('请输入有效的邮箱地址');
      return;
    }
    if (!password) { setError('请输入密码'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '登录失败'); return; }
      onSuccess(data.user);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  // --- Password register ---
  const handlePasswordRegister = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('请输入有效的邮箱地址');
      return;
    }
    if (!password || password.length < 8) { setError('密码至少 8 个字符'); return; }
    if (password !== confirmPassword) { setError('两次密码不一致'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '注册失败'); return; }
      setStep('code');
      setCountdown(60);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  if (!isOpen) return null;

  const title = mode === 'choose' ? '登录 / 注册'
    : mode === 'email-code' ? (step === 'code' ? '输入验证码' : '验证码登录')
    : mode === 'password-login' ? '密码登录'
    : step === 'code' ? '输入验证码' : '注册账号';

  return (
    <div className="fixed inset-0 z-[140] bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-[380px] rounded-2xl border border-border bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            {mode !== 'choose' && (
              <button
                onClick={goBack}
                className="w-7 h-7 rounded-md hover:bg-surface2 text-text3 flex items-center justify-center"
              >
                <ArrowLeft size={14} />
              </button>
            )}
            <div className="text-[15px] font-semibold text-text-main">{title}</div>
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
          {/* Mode: Choose */}
          {mode === 'choose' && (
            <div className="flex flex-col gap-3">
              <button
                onClick={() => setMode('email-code')}
                className="w-full py-3 rounded-xl text-[14px] font-medium border border-border text-text-main hover:bg-surface2 transition-colors flex items-center justify-center gap-2"
              >
                <Mail size={16} />
                验证码登录
              </button>
              <button
                onClick={() => setMode('password-login')}
                className="w-full py-3 rounded-xl text-[14px] font-medium bg-accent text-white hover:opacity-90 transition-all flex items-center justify-center gap-2"
              >
                <Lock size={16} />
                密码登录
              </button>
              <div className="text-center pt-2">
                <button
                  onClick={() => setMode('password-register')}
                  className="text-[13px] text-accent hover:underline"
                >
                  新用户？注册账号
                </button>
              </div>
            </div>
          )}

          {/* Mode: Email Code */}
          {mode === 'email-code' && step === 'form' && (
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
                  loading ? "bg-accent/60 text-white cursor-wait" : "bg-accent text-white hover:opacity-90"
                )}
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? '发送中...' : '发送验证码'}
              </button>
            </>
          )}

          {/* Code verification (shared by email-code and password-register) */}
          {(mode === 'email-code' || mode === 'password-register') && step === 'code' && (
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
                onKeyDown={e => { if (e.key === 'Enter') void handleVerifyCode(); }}
                placeholder="输入 6 位验证码"
                className="w-full px-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main text-center tracking-[6px] outline-none focus:border-accent transition-colors mb-3"
              />
              {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
              <button
                onClick={() => void handleVerifyCode()}
                disabled={loading}
                className={cn(
                  "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2 mb-3",
                  loading ? "bg-accent/60 text-white cursor-wait" : "bg-accent text-white hover:opacity-90"
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

          {/* Mode: Password Login */}
          {mode === 'password-login' && (
            <>
              <div className="relative mb-3">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') passwordInputRef.current?.focus(); }}
                  placeholder="your@email.com"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
              </div>
              <div className="relative mb-3">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  ref={passwordInputRef}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') void handlePasswordLogin(); }}
                  placeholder="输入密码"
                  className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text3 hover:text-text-main"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
              <button
                onClick={() => void handlePasswordLogin()}
                disabled={loading}
                className={cn(
                  "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2 mb-3",
                  loading ? "bg-accent/60 text-white cursor-wait" : "bg-accent text-white hover:opacity-90"
                )}
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? '登录中...' : '登录'}
              </button>
              <div className="text-center">
                <button
                  onClick={() => { setMode('email-code'); setStep('form'); setError(''); }}
                  className="text-[13px] text-text3 hover:text-accent transition-colors"
                >
                  没有密码？使用验证码登录
                </button>
              </div>
            </>
          )}

          {/* Mode: Password Register */}
          {mode === 'password-register' && step === 'form' && (
            <>
              <div className="relative mb-3">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(''); }}
                  placeholder="your@email.com"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
              </div>
              <div className="relative mb-3">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder="设置密码（至少 8 个字符）"
                  className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text3 hover:text-text-main"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="relative mb-3">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => { setConfirmPassword(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') void handlePasswordRegister(); }}
                  placeholder="确认密码"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
              </div>
              {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
              <button
                onClick={() => void handlePasswordRegister()}
                disabled={loading}
                className={cn(
                  "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2 mb-3",
                  loading ? "bg-accent/60 text-white cursor-wait" : "bg-accent text-white hover:opacity-90"
                )}
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? '注册中...' : '注册'}
              </button>
              <div className="text-center">
                <button
                  onClick={() => { setMode('password-login'); setError(''); }}
                  className="text-[13px] text-text3 hover:text-accent transition-colors"
                >
                  已有账号？直接登录
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
