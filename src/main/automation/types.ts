export type AccountStatus = 'authenticated' | 'unauthenticated' | 'active' | 'error' | 'live' | 'die';

export type SeedingStateChange = {
  isRunning: boolean;
  canceled?: boolean;
  reason?: string;
};

export interface AccountInfo {
  id: string;
  username: string;
  password?: string;
  email?: string;
  passMail?: string;
  twoFactor?: string;
  cookie?: string;
}
