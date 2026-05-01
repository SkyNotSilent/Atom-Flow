type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogContext = Record<string, unknown>;

declare global {
  interface ImportMeta {
    env: {
      DEV: boolean;
    };
  }
}

const isDevelopment = import.meta.env.DEV;

const normalizeError = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
};

const normalizeContext = (context?: LogContext): LogContext => {
  if (!context) return {};
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, normalizeError(value)])
  );
};

const reportToServer = (level: 'warn' | 'error', message: string, context?: LogContext) => {
  const body = JSON.stringify({
    level,
    message,
    context: {
      ...normalizeContext(context),
      url: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    },
  });

  const blob = new Blob([body], { type: 'application/json' });
  if (navigator.sendBeacon?.('/api/log', blob)) {
    return;
  }

  void fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
};

const writeDevConsole = (level: LogLevel, message: string, context?: LogContext) => {
  if (!isDevelopment) return;
  const payload = context ? normalizeContext(context) : undefined;
  if (level === 'debug') {
    console.debug(message, payload);
  } else if (level === 'info') {
    console.info(message, payload);
  } else if (level === 'warn') {
    console.warn(message, payload);
  } else {
    console.error(message, payload);
  }
};

export const logger = {
  debug(message: string, context?: LogContext) {
    writeDevConsole('debug', message, context);
  },
  info(message: string, context?: LogContext) {
    writeDevConsole('info', message, context);
  },
  warn(message: string, context?: LogContext) {
    writeDevConsole('warn', message, context);
    reportToServer('warn', message, context);
  },
  error(message: string, context?: LogContext) {
    writeDevConsole('error', message, context);
    reportToServer('error', message, context);
  },
};

export const captureGlobalError = (message: string, error?: unknown, context?: LogContext) => {
  logger.error(message, { ...context, error: normalizeError(error) });
};
