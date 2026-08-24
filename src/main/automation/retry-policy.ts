import { BrowserWindow } from 'electron';
import { TaskLogItem } from '../nest/automation/automation.interface';
import { SeedingCancelledError, isSeedingCancelRequested, waitForSeedingDelay } from './seeding-control';

export type AutomationFailureKind =
  | 'cancelled'
  | 'window_closed'
  | 'auth'
  | 'captcha'
  | 'network'
  | 'render'
  | 'ui_changed'
  | 'unknown';

export interface AutomationRetryDecision {
  kind: AutomationFailureKind;
  retryable: boolean;
  reason: string;
}

export interface AutomationRetryOptions {
  label: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

type AutomationLog = (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void;

export function classifyAutomationError(err: unknown): AutomationRetryDecision {
  const message = err instanceof Error ? err.message : String(err || '');
  const normalized = message.toLowerCase();

  if (err instanceof SeedingCancelledError || isSeedingCancelRequested()) {
    const kind = normalized.includes('window') && normalized.includes('closed') ? 'window_closed' : 'cancelled';
    return { kind, retryable: false, reason: message || 'Seeding was cancelled.' };
  }

  if (normalized.includes('window') && (normalized.includes('closed') || normalized.includes('destroyed'))) {
    return { kind: 'window_closed', retryable: false, reason: message };
  }

  if (
    normalized.includes('logged out') ||
    normalized.includes('could not be re-authenticated') ||
    normalized.includes('login retry failed') ||
    normalized.includes('session expired') ||
    normalized.includes('chua co mat khau') ||
    normalized.includes('chưa dựng session')
  ) {
    return { kind: 'auth', retryable: false, reason: message };
  }

  if (normalized.includes('captcha')) {
    return { kind: 'captcha', retryable: true, reason: message };
  }

  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('err_connection') ||
    normalized.includes('err_proxy') ||
    normalized.includes('err_name_not_resolved') ||
    normalized.includes('net::')
  ) {
    return { kind: 'network', retryable: true, reason: message };
  }

  if (
    normalized.includes('blank') ||
    normalized.includes('trang bi trong') ||
    normalized.includes('trang/trong') ||
    normalized.includes('bodyhtml=0') ||
    normalized.includes('tiktok chưa ổn định') ||
    normalized.includes('surface')
  ) {
    return { kind: 'render', retryable: true, reason: message };
  }

  if (
    normalized.includes('not found') ||
    normalized.includes('target') ||
    normalized.includes('selector') ||
    normalized.includes('comment-input') ||
    normalized.includes('like')
  ) {
    return { kind: 'ui_changed', retryable: true, reason: message };
  }

  return { kind: 'unknown', retryable: true, reason: message || 'Unknown automation error.' };
}

export async function runWithAutomationRetry<T>(
  win: BrowserWindow,
  acc: { id: string; username: string },
  onLog: AutomationLog,
  options: AutomationRetryOptions,
  task: () => Promise<T>
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(250, options.baseDelayMs ?? 1500);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 8000);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      const decision = classifyAutomationError(err);
      const isLastAttempt = attempt >= maxAttempts;

      if (!decision.retryable || isLastAttempt || win.isDestroyed() || isSeedingCancelRequested()) {
        throw err;
      }

      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitterMs = Math.round(Math.random() * 600);
      const delayMs = exponentialDelay + jitterMs;

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `[Retry] ${options.label} lỗi tạm thời (${decision.kind}) cho @${acc.username}: ${decision.reason}. Thử lại ${attempt + 1}/${maxAttempts} sau ${Math.round(delayMs / 1000)}s.`,
      });

      await waitForSeedingDelay(delayMs, win);
    }
  }

  throw new Error(`${options.label} failed without returning a result.`);
}
