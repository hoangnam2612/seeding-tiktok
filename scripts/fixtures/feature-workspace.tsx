import App from '../../src/renderer/src/App';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureWorkspace } from '../../src/renderer/src/components/FeatureWorkspace';
import '../../src/renderer/src/index.css';

const fixtureAccount = { id: 'fixture', username: 'demo_account', uid: '123456789', displayName: 'Tài khoản kiểm thử', email: 'demo@example.test', status: 'authenticated', categoryId: 'group' };
let state: any = { available: true, isRunning: false, events: [], results: [], deviceCodes: {}, settings: { columns: 4, rows: 2, scaleFactor: .65, livePageZoom: .8, maxThreads: 4, autoArrangeGrid: true, disableImages: false, disableAudio: true, windowWidth: 0, windowHeight: 0 } };
(window as any).fixtureCalls = [];
(window as any).electronAPI = {
  focusWindow: async () => {},
  getApiAuthToken: async () => 'fixture',
  workflows: async (action: string, payload: any) => {
    (window as any).fixtureCalls.push({ action, payload });
    if (action === 'state') return state;
    if (action === 'start') { state = { ...state, isRunning: true, command: payload.command, message: 'Đang chạy fixture…' }; return { success: true }; }
    if (action === 'cancel') { state = { ...state, isRunning: false, message: 'Đã dừng fixture.' }; return { success: true }; }
    if (action === 'files') return [{ path: 'C:\\fixtures\\video.mp4', title: 'Sản phẩm mùa thu', description: 'Giới thiệu sản phẩm', size: '12000000' }];
    if (action === 'settings') { state.settings = payload; return { success: true }; }
    return { success: true };
  },
};
const originalFetch = async (input: any) => new Response(JSON.stringify({ success: true, data: String(input).endsWith('/categories') ? [{ id: 'group', name: 'Nhóm mẫu' }] : String(input).endsWith('/proxies') ? [] : [fixtureAccount] }), { headers: { 'Content-Type': 'application/json' } });
const root = createRoot(document.getElementById('root')!);
(window as any).showFeature = (tab: any) => root.render(<div style={{ height: '100vh', overflow: 'auto', background: 'var(--bg-app)' }}><FeatureWorkspace tab={tab} /></div>);
(window as any).showFeature('upload');

window.fetch = async (input: any) => { if (String(input).includes('/client-auth/')) return new Response(JSON.stringify({ success: true, data: String(input).endsWith('remembered-login') ? null : { auth: { authenticated: false, licensed: false } } }), { headers: { 'Content-Type': 'application/json' } }); return originalFetch(input); };
(window as any).showAuth = () => root.render(<App />);
