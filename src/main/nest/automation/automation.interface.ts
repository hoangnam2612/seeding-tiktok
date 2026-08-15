export interface SeedingTaskConfig {
  targetUrl: string;
  targetType: 'video' | 'livestream';
  accountIds: string[];
  likeEnabled: boolean;
  comments: string[];
  delaySeconds: number;
  maxThreads?: number;
  liveDurationSeconds?: number;
  muteBrowserAudio?: boolean;
}

export interface TaskLogItem {
  id: string;
  timestamp: string;
  accountId?: string;
  accountUsername?: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}
