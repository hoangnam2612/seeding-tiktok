export type AccountStatus =
  | 'live'
  | 'die'
  | 'unauthenticated'
  | 'authenticated'
  | 'checkpoint'
  | 'active'
  | 'error';

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
