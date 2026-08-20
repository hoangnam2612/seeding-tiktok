import * as crypto from 'crypto';

export const API_AUTH_HEADER = 'x-seeding-app-token';

const apiAuthToken = crypto.randomBytes(32).toString('hex');

export function getApiAuthToken(): string {
  return apiAuthToken;
}

export function isValidApiAuthToken(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value === apiAuthToken;
}
