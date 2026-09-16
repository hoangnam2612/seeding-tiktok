export type AccountStatus =
  | 'live'
  | 'die'
  | 'unauthenticated'
  | 'authenticated'
  | 'checkpoint'
  | 'active'
  | 'error';

export interface AccountCategory {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
}

export interface TikTokAccount {
  id: string;
  username: string;
  uid?: string;
  recoveryMail?: string;
  userAgent?: string;
  bio?: string;
  password?: string;
  displayName: string;
  notes?: string;
  categoryId?: string;
  cookie?: string;
  token?: string;
  email?: string;
  passMail?: string;
  refreshToken?: string;
  clientId?: string;
  twoFactor?: string;
  proxy?: string;
  proxyType?: 'none' | 'http' | 'socks5' | 'tmproxy' | 'tinsoft';
  avatarUrl?: string;
  followerCount?: number;
  followingCount?: number;
  likesCount?: number;
  lastAction?: string;
  lastActionAt?: string;
  message?: string;
  status: AccountStatus;
  lastChecked?: string;
  lastUsed?: string;
  createdAt: string;
}

export interface ProxyEntry {
  id: string;
  value: string;
  proxyType: 'none' | 'http' | 'socks5' | 'tmproxy' | 'tinsoft';
  label?: string;
  assignedAccountId?: string;
  status?: 'untested' | 'active' | 'error';
  lastChecked?: string;
  createdAt: string;
}

export interface TaskLogItem {
  id: string;
  timestamp: string;
  accountId?: string;
  accountUsername?: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface ClientAuthState {
  authenticated: boolean;
  licensed: boolean;
  blocked: boolean;
  user?: {
    id: string;
    username: string;
    email: string;
    role?: string;
    status?: string;
  };
  appCode: string;
  expiresAt?: string | null;
  isExpired: boolean;
  message?: string;
  lastCheckedAt?: string;
}
