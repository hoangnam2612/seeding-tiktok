export interface ClientAuthUser {
  id: string;
  username: string;
  email: string;
  role?: string;
  status?: string;
}

export interface ClientAuthState {
  accessToken?: string;
  refreshToken?: string;
  user?: ClientAuthUser;
  appCode?: string;
  expiresAt?: string | null;
  isExpired?: boolean;
  lastCheckedAt?: string;
}

export interface PublicClientAuthState {
  authenticated: boolean;
  licensed: boolean;
  blocked: boolean;
  user?: ClientAuthUser;
  appCode: string;
  expiresAt?: string | null;
  isExpired: boolean;
  message?: string;
  lastCheckedAt?: string;
}

export interface ClientAuthApiResult<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  statusCode?: number;
}
