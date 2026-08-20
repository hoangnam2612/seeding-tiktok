export const NEST_BASE_URL = 'http://127.0.0.1:3000/api';

let cachedApiAuthToken = '';

export async function getApiAuthToken(): Promise<string> {
  if (cachedApiAuthToken) return cachedApiAuthToken;
  cachedApiAuthToken = (await window.electronAPI?.getApiAuthToken?.()) || '';
  return cachedApiAuthToken;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = await getApiAuthToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set('X-Seeding-App-Token', token);
  return fetch(input, { ...init, headers });
}
