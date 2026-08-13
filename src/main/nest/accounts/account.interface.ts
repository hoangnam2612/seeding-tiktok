export interface AccountCategory {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
}

export interface TikTokAccount {
  id: string;
  username: string;
  password?: string;
  displayName: string;
  notes?: string;
  categoryId?: string;
  cookie?: string;
  token?: string;
  email?: string;
  passMail?: string;
  twoFactor?: string;
  proxy?: string;
  proxyType?: 'none' | 'http' | 'socks5' | 'tmproxy' | 'tinsoft';
  avatarUrl?: string;
  followerCount?: number;
  followingCount?: number;
  status: 'live' | 'die' | 'unauthenticated' | 'authenticated' | 'checkpoint' | 'active' | 'error';
  lastChecked?: string;
  lastUsed?: string;
  createdAt: string;
}

