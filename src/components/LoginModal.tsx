import React, { useState, useEffect, useRef } from 'react';
import { X, Mail, ArrowLeft, Loader2, Lock, Eye, EyeOff } from 'lucide-react';
import { cn } from './Nav';
import { User } from '../types';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: User) => void;
}

// login: default, email+password
// register: email+password+confirm → verify code
// forgot: email → verify code → set new password
type Mode = 'login' | 'register' | 'forgot';
type Step = 'form' | 'code' | 'new-password';

export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [mode, setMode] = useState<Mode>('login');
  const [step, setStep] = useState<Step>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
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
    if (step === 'code') {
      setTimeout(() => codeInputRef.current?.focus(), 100);
    } else if (mode === 'login') {
      setTimeout(() => emailInputRef.current?.focus(), 100);
    } else {
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
      setMode('login');
      setStep('form');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setCode('');
      setError('');
      setLoading(false);
      setCountdown(0);
      setShowPassword(false);
    }
  }, [isOpen]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setStep('form');
    setCode('');
    setError('');
    setPassword('');
    setConfirmPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setShowPassword(false);
  };

  const goBack = () => {
    setError('');
    if (step === 'new-password') { setStep('code'); return; }
    if (step === 'code') { setStep('form'); setCode(''); return; }
    switchMode('login');
  };

  const validateEmail = () => {
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('请输入有效的邮箱地址');
      return false;
    }
    return true;
  };

  // --- Login with password ---
  const handleLogin = async () => {
    if (!validateEmail()) return;
    if (!password) { setError('请输入密码'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '登录失败'); return; }
      onSuccess(data.user);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  // --- Register: send code ---
  const handleRegisterSendCode = async () => {
    if (!validateEmail()) return;
    if (!password || password.length < 8) { setError('密码至少 8 个字符'); return; }
    if (password !== confirmPassword) { setError('两次密码不一致'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '注册失败'); return; }
      setStep('code');
      setCountdown(60);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  // --- Register: verify code ---
  const handleRegisterVerify = async () => {
    const trimmedCode = code.trim();
    if (!trimmedCode || trimmedCode.length !== 6) { setError('请输入 6 位验证码'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: trimmedCode }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '验证失败'); return; }
      onSuccess(data.user);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  // --- Forgot: send code ---
  const handleForgotSendCode = async () => {
    if (!validateEmail()) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '发送失败'); return; }
      setStep('code');
      setCountdown(60);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  // --- Forgot: verify code → go to new-password step ---
  const handleForgotVerifyCode = () => {
    const trimmedCode = code.trim();
    if (!trimmedCode || trimmedCode.length !== 6) { setError('请输入 6 位验证码'); return; }
    setError('');
    setStep('new-password');
  };

  // --- Forgot: reset password ---
  const handleResetPassword = async () => {
    if (!newPassword || newPassword.length < 8) { setError('密码至少 8 个字符'); return; }
    if (newPassword !== confirmNewPassword) { setError('两次密码不一致'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim(), password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '重置失败'); return; }
      onSuccess(data.user);
    } catch { setError('网络错误，请稍后再试'); } finally { setLoading(false); }
  };

  // --- Resend code ---
  const handleResend = async () => {
    if (countdown > 0) return;
    setError('');
    setLoading(true);
    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/send-code';
      const body = mode === 'register'
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

  if (!isOpen) return null;

  const title =
    mode === 'login' ? '登录' :
    mode === 'register' ? (step === 'code' ? '输入验证码' : '注册账号') :
    step === 'form' ? '忘记密码' :
    step === 'code' ? '输入验证码' : '设置新密码';

  const showBackButton = mode !== 'login' || step !== 'form';

  return (
    <div className="fixed inset-0 z-[140] bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-[380px] rounded-2xl border border-border bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            {showBackButton && (
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

          {/* ===== LOGIN (default) ===== */}
          {mode === 'login' && (
            <>
              <div className="relative mb-3">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') passwordInputRef.current?.focus(); }}
                  placeholder="邮箱地址"
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
                  onKeyDown={e => { if (e.key === 'Enter') void handleLogin(); }}
                  placeholder="密码"
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
                onClick={() => void handleLogin()}
                disabled={loading}
                className={cn(
                  "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2",
                  loading ? "bg-accent/60 text-white cursor-wait" : "bg-accent text-white hover:opacity-90"
                )}
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? '登录中...' : '登录'}
              </button>
              <div className="flex items-center justify-between mt-4">
                <button
                  onClick={() => switchMode('register')}
                  className="text-[13px] text-accent hover:underline"
                >
                  注册账号
                </button>
                <button
                  onClick={() => switchMode('forgot')}
                  className="text-[13px] text-text3 hover:text-accent transition-colors"
                >
                  忘记密码
                </button>
              </div>
            </>
          )}

          {/* ===== REGISTER: form ===== */}
          {mode === 'register' && step === 'form' && (
            <>
              <div className="relative mb-3">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(''); }}
                  placeholder="邮箱地址"
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
                  onKeyDown={e => { if (e.key === 'Enter') void handleRegisterSendCode(); }}
                  placeholder="确认密码"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
              </div>
              {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
              <button
                onClick={() => void handleRegisterSendCode()}
                disabled={loading}
                className={cn(
                  "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2",
                  loading ? "bg-accent/60 text-white cursor-wait" : "bg-accent text-white hover:opacity-90"
                )}
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? '发送验证码...' : '注册'}
              </button>
              <div className="text-center mt-4">
                <button
                  onClick={() => switchMode('login')}
                  className="text-[13px] text-text3 hover:text-accent transition-colors"
                >
                  已有账号？直接登录
                </button>
              </div>
            </>
          )}

          {/* ===== REGISTER: verify code ===== */}
          {mode === 'register' && step === 'code' && (
            <CodeVerifyStep
              email={email}
              code={code}
              setCode={setCode}
              error={error}
              setError={setError}
              loading={loading}
              countdown={countdown}
              codeInputRef={codeInputRef}
              onVerify={handleRegisterVerify}
              onResend={handleResend}
            />
          )}

          {/* ===== FORGOT: enter email ===== */}
          {mode === 'forgot' && step === 'form' && (
            <>
              <p className="text-[13px] text-text3 mb-4">输入你的注册邮箱，我们会发送验证码</p>
              <div className="relative mb-3">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') void handleForgotSendCode(); }}
                  placeholder="邮箱地址"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
              </div>
              {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
              <button
                onClick={() => void handleForgotSendCode()}
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

          {/* ===== FORGOT: verify code ===== */}
          {mode === 'forgot' && step === 'code' && (
            <CodeVerifyStep
              email={email}
              code={code}
              setCode={setCode}
              error={error}
              setError={setError}
              loading={loading}
              countdown={countdown}
              codeInputRef={codeInputRef}
              onVerify={handleForgotVerifyCode}
              onResend={handleResend}
              verifyLabel="下一步"
            />
          )}

          {/* ===== FORGOT: set new password ===== */}
          {mode === 'forgot' && step === 'new-password' && (
            <>
              <p className="text-[13px] text-text3 mb-4">请设置新密码</p>
              <div className="relative mb-3">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => { setNewPassword(e.target.value); setError(''); }}
                  placeholder="新密码（至少 8 个字符）"
                  className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                  autoFocus
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
                  value={confirmNewPassword}
                  onChange={e => { setConfirmNewPassword(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') void handleResetPassword(); }}
                  placeholder="确认新密码"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main outline-none focus:border-accent transition-colors"
                />
              </div>
              {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
              <button
                onClick={() => void handleResetPassword()}
                disabled={loading}
                className={cn(
                  "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2",
                  loading ? "bg-accent/60 text-white cursor-wait" : "bg-accent text-white hover:opacity-90"
                )}
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? '重置中...' : '重置密码并登录'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// Shared code verification sub-component
const CodeVerifyStep: React.FC<{
  email: string;
  code: string;
  setCode: (v: string) => void;
  error: string;
  setError: (v: string) => void;
  loading: boolean;
  countdown: number;
  codeInputRef: React.RefObject<HTMLInputElement | null>;
  onVerify: () => void | Promise<void>;
  onResend: () => void | Promise<void>;
  verifyLabel?: string;
}> = ({ email, code, setCode, error, setError, loading, countdown, codeInputRef, onVerify, onResend, verifyLabel = '验证并登录' }) => (
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
      onKeyDown={e => { if (e.key === 'Enter') void onVerify(); }}
      placeholder="输入 6 位验证码"
      className="w-full px-3 py-2.5 rounded-xl border border-border bg-bg text-[14px] text-text-main text-center tracking-[6px] outline-none focus:border-accent transition-colors mb-3"
    />
    {error && <p className="text-[12px] text-red-500 mb-3">{error}</p>}
    <button
      onClick={() => void onVerify()}
      disabled={loading}
      className={cn(
        "w-full py-2.5 rounded-xl text-[14px] font-medium transition-all flex items-center justify-center gap-2 mb-3",
        loading ? "bg-accent/60 text-white cursor-wait" : "bg-accent text-white hover:opacity-90"
      )}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {loading ? '验证中...' : verifyLabel}
    </button>
    <button
      onClick={() => void onResend()}
      disabled={countdown > 0 || loading}
      className="w-full text-[13px] text-text3 hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {countdown > 0 ? `${countdown} 秒后可重新发送` : '重新发送验证码'}
    </button>
  </>
);
