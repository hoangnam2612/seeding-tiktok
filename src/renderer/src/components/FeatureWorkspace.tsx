import React, { useEffect, useState } from 'react';
import { AccountCategory, TikTokAccount, ProxyEntry } from '../types';
import { apiFetch, NEST_BASE_URL } from '../utils/api';
import './feature-workspace.css';

export type FeatureTab = 'video-live' | 'profile' | 'upload' | 'tools' | 'browser-settings';
export const featureTabs: [FeatureTab, string][] = [
  ['video-live', 'Seeding'],
  ['upload', 'Đăng video'],
  ['profile', 'Đổi profile'],
  ['browser-settings', 'Cài đặt chung'],
];
const invoke = (action: string, payload?: any) => {
  if (!window.electronAPI?.workflows) return Promise.reject(new Error('Tính năng này cần chạy trong ứng dụng Electron.'));
  return window.electronAPI.workflows(action, payload);
};
const lines = (text: string) => text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
type Field = { key: string; label: string; kind: 'number' | 'boolean' | 'lines' | 'select'; options?: [number, string][]; min?: number; max?: number; step?: number };
const num = (key: string, label: string, min = 0, max = 86400, step = 1): Field => ({ key, label, kind: 'number', min, max, step });
const flag = (key: string, label: string): Field => ({ key, label, kind: 'boolean' });
const multiline = (key: string, label: string): Field => ({ key, label, kind: 'lines' });
const configs: Record<string, { defaults: any; fields: Field[] }> = {
  video: {
    defaults: { videoUrls: [], minViewSeconds: 5, maxViewSeconds: 15, isLike: true, isComment: true, comments: [], isFollow: false, isFavorite: false, minDelaySeconds: 3, maxDelaySeconds: 6 },
    fields: [multiline('videoUrls', 'URL video — mỗi dòng một link'), num('minViewSeconds', 'Xem ít nhất (giây)'), num('maxViewSeconds', 'Xem nhiều nhất (giây)'), flag('isLike', 'Thả tim video'), flag('isComment', 'Bình luận'), flag('isFollow', 'Follow tác giả'), flag('isFavorite', 'Lưu yêu thích'), multiline('comments', 'Bình luận — hỗ trợ {xin chào|chào bạn}'), num('minDelaySeconds', 'Nghỉ ít nhất (giây)'), num('maxDelaySeconds', 'Nghỉ nhiều nhất (giây)')],
  },
  live: {
    defaults: { liveUrls: [], minWatchMinutes: 1, maxWatchMinutes: 3, isSendHearts: true, heartClicksPerRound: 15, isCommentLive: true, liveComments: [], commentIntervalSeconds: 15, isFollowHost: false },
    fields: [multiline('liveUrls', 'URL livestream — mỗi dòng một link'), num('minWatchMinutes', 'Xem ít nhất (phút)'), num('maxWatchMinutes', 'Xem nhiều nhất (phút)'), flag('isSendHearts', 'Thả tim live'), num('heartClicksPerRound', 'Số tim mỗi vòng', 0, 1000), flag('isCommentLive', 'Bình luận live'), num('commentIntervalSeconds', 'Chu kỳ bình luận (giây)', 1), flag('isFollowHost', 'Follow chủ live'), multiline('liveComments', 'Bình luận live — mỗi dòng một nội dung')],
  },
  profile: {
    defaults: { isChangeAvatar: false, avatarFolder: '', avatarFiles: [], isChangeName: false, names: [], isChangeUsername: false, usernames: [], appendRandomNumber: true, minRandomNumber: 1000, maxRandomNumber: 9999, isChangeBio: false, bios: [], minDelaySeconds: 2, maxDelaySeconds: 5, avoidDuplicateContent: false },
    fields: [flag('isChangeAvatar', 'Đổi avatar'), flag('isChangeName', 'Đổi tên hiển thị'), multiline('names', 'Tên hiển thị — mỗi dòng một tên, hỗ trợ spintax'), flag('isChangeUsername', 'Đổi username / TikTok ID'), multiline('usernames', 'Username — mỗi dòng một tên'), flag('appendRandomNumber', 'Thêm số ngẫu nhiên vào username'), num('minRandomNumber', 'Số ngẫu nhiên nhỏ nhất'), num('maxRandomNumber', 'Số ngẫu nhiên lớn nhất'), flag('isChangeBio', 'Đổi tiểu sử'), multiline('bios', 'Tiểu sử — mỗi dòng một nội dung, hỗ trợ spintax'), flag('avoidDuplicateContent', 'Không dùng lại nội dung giữa các tài khoản'), num('minDelaySeconds', 'Nghỉ ít nhất (giây)'), num('maxDelaySeconds', 'Nghỉ nhiều nhất (giây)')],
  },
  upload: {
    defaults: { videos: [], attachProducts: false, productLines: [], captions: [], hashtags: [], tags: [], useVideoDescription: true, setPublicVisibility: true, maxTags: 3, uploadTimeoutSeconds: 180, postWaitSeconds: 30, minDelaySeconds: 5, maxDelaySeconds: 10 },
    fields: [flag('attachProducts', 'Gắn sản phẩm vào video'), multiline('productLines', 'Sản phẩm: ID|Tên hiển thị — đúng một dòng cho mỗi video, cùng thứ tự'), multiline('captions', 'Caption — mỗi dòng một nội dung'), multiline('hashtags', 'Hashtag — mỗi dòng một hashtag'), multiline('tags', 'Tài khoản cần tag — mỗi dòng một username'), flag('useVideoDescription', 'Dùng mô tả của video'), flag('setPublicVisibility', 'Đặt quyền xem công khai'), num('maxTags', 'Số tag tối đa', 0, 100), num('uploadTimeoutSeconds', 'Chờ upload tối đa (giây)', 1), num('postWaitSeconds', 'Chờ xử lý bài đăng (giây)', 1)],
  },
};
const browserFields: Field[] = [num('maxThreads', 'Số luồng tối đa', 1, 32), num('columns', 'Số cột', 1, 32), num('rows', 'Số hàng', 1, 32), { key: 'scaleFactor', label: 'Tỷ lệ giao diện Chrome', kind: 'select', options: [[.5, '50% (Rất nhỏ)'], [.65, '65%'], [.75, '75% (Khuyên dùng)'], [.85, '85%'], [1, '100% (Gốc)']] }, { key: 'livePageZoom', label: 'Zoom trang live', kind: 'select', options: [[.6, '60% (Rất nhỏ)'], [.7, '70% (Nhỏ)'], [.8, '80% (Khuyên dùng)'], [.9, '90%'], [1, '100% (Gốc)']] }, num('windowWidth', 'Chiều rộng (0 = tự động)', 0, 8000), num('windowHeight', 'Chiều cao (0 = tự động)', 0, 8000), flag('autoArrangeGrid', 'Tự sắp xếp cửa sổ theo lưới'), flag('disableImages', 'Tắt tải ảnh'), flag('disableAudio', 'Tắt âm thanh')];

function Fields({ fields, value, onChange }: { fields: Field[]; value: any; onChange: (key: string, value: any) => void }) {
  return <div className="feature-fields">{fields.map(f => <label key={f.key} className={`feature-field ${f.kind === 'lines' ? 'feature-wide' : ''}`}>
    {f.kind === 'boolean' ? <span className="feature-check"><input type="checkbox" checked={!!value[f.key]} onChange={e => onChange(f.key, e.target.checked)} />{f.label}</span>
      : <><span>{f.label}</span>{f.kind === 'lines'
        ? <textarea rows={4} value={typeof value[f.key] === 'string' ? value[f.key] : (value[f.key] || []).join('\n')} onChange={e => onChange(f.key, e.target.value)} />
        : f.kind === 'select' ? <select value={value[f.key]} onChange={e => onChange(f.key, Number(e.target.value))}>{f.options!.map(([amount, label]) => <option key={amount} value={amount}>{label}</option>)}</select>
        : <input type="number" min={f.min} max={f.max} step={f.step} required value={value[f.key] ?? ''} onChange={e => onChange(f.key, e.target.value === '' ? '' : Number(e.target.value))} />}</>}
  </label>)}</div>;
}

export function FeatureWorkspace({ tab }: { tab: FeatureTab }) {
  const [mode, setMode] = useState('video');
  const key = tab === 'video-live' ? mode : tab;
  const [drafts, setDrafts] = useState<any>(() => {
    try { return JSON.parse(localStorage.getItem('workflow-feature-drafts') || '{}'); } catch { return {}; }
  });
  const value = { ...configs[key]?.defaults, ...drafts[key] };
  const set = (field: string, data: any) => setDrafts((old: any) => ({ ...old, [key]: { ...old[key], [field]: data } }));
  const [accounts, setAccounts] = useState<TikTokAccount[]>([]);
  const [categories, setCategories] = useState<AccountCategory[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [state, setState] = useState<any>({ events: [], results: [], deviceCodes: {} });
  const [browser, setBrowser] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const [format, setFormat] = useState('UID|PASS|MAIL|PASSMAIL');
  const [copyFormat, setCopyFormat] = useState('UID|PASS|2FA');
  const [bulkStatus, setBulkStatus] = useState('live');
  const [edit, setEdit] = useState<TikTokAccount | null>(null);
  const [proxies, setProxies] = useState<ProxyEntry[]>([]);
  const [proxyIds, setProxyIds] = useState<string[]>([]);
  const [proxyEdit, setProxyEdit] = useState<ProxyEntry | null>(null);
  useEffect(() => { localStorage.setItem('workflow-feature-drafts', JSON.stringify(drafts)); }, [drafts]);
  async function reload() {
    const results = await Promise.all([apiFetch(`${NEST_BASE_URL}/accounts`), apiFetch(`${NEST_BASE_URL}/accounts/categories`), apiFetch(`${NEST_BASE_URL}/accounts/proxies`)]);
    const [a, c, p] = await Promise.all(results.map(r => r.json()));
    setAccounts(a.data || []); setCategories(c.data || []); setProxies(p.data || []);
    setSelectedIds(old => old.filter(id => (a.data || []).some((item: TikTokAccount) => item.id === id)));
  }
  useEffect(() => {
    let active = true;
    reload().catch(e => setError(e.message));
    const poll = async () => {
      try {
        const current = await invoke('state');
        if (!active) return;
        setState(current); setBrowser((old: any) => old || { ...current.settings, scaleFactor: current.settings.scaleFactor <= .55 ? .5 : current.settings.scaleFactor <= .68 ? .65 : current.settings.scaleFactor <= .78 ? .75 : current.settings.scaleFactor <= .88 ? .85 : 1, livePageZoom: current.settings.livePageZoom <= .65 ? .6 : current.settings.livePageZoom <= .75 ? .7 : current.settings.livePageZoom <= .85 ? .8 : current.settings.livePageZoom <= .95 ? .9 : 1 });
      } catch (e: any) { if (active) setError(e.message); }
    };
    poll(); const timer = setInterval(poll, 1000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const visible = accounts.filter(a => (category === 'all' || a.categoryId === category) && `${a.username} ${a.uid || ''} ${a.email || ''} ${a.notes || ''}`.toLowerCase().includes(search.toLowerCase()));
  const allChecked = visible.length > 0 && visible.every(a => selectedIds.includes(a.id));
  const locked = busy || state.isRunning;
  const act = async (work: () => Promise<any>) => {
    setBusy(true); setError(''); setMessage('');
    try { return await work(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const start = (command: string) => act(async () => {
    const config = { ...value };
    for (const field of configs[key]?.fields || []) if (field.kind === 'lines') config[field.key] = typeof config[field.key] === 'string' ? lines(config[field.key]) : config[field.key];
    if (command === 'upload') {
      config.products = (config.productLines || []).map((line: string) => {
        const index = line.indexOf('|');
        return { id: (index < 0 ? line : line.slice(0, index)).trim(), displayName: index < 0 ? '' : line.slice(index + 1).trim() };
      });
    }
    await invoke('start', { command, accountIds: selectedIds, config });
    setState(await invoke('state'));
  });
  const selectFiles = (kind: string) => act(async () => {
    const files = await invoke('files', { kind });
    if (!files.length) return;
    if (kind === 'video') set('videos', [...(value.videos || []), ...files.filter((f: any) => !(value.videos || []).some((v: any) => v.path === f.path))]);
    else if (kind === 'folder') { set('avatarFolder', files[0].path); set('avatarFiles', []); }
    else set('avatarFiles', files.map((f: any) => f.path));
  });
  const exportAccounts = (excel: boolean) => act(async () => {
    const result = await invoke('export', { accountIds: selectedIds, format, excel });
    if (!result.canceled) setMessage('Đã xuất tài khoản.');
  });
  const heading = featureTabs.find(([id]) => id === tab)?.[1];
  if (tab === 'video-live' || tab === 'upload' || tab === 'profile') return <section className="feature-workspace seeding-workspace">
    <header className="feature-heading"><div><h2>{heading}</h2><p>Cấu hình tác vụ và chọn tài khoản thực hiện.</p></div></header>
    {error && <div role="alert" className="feature-notice feature-error">{error}</div>}
    <div className="seeding-layout">
      <form id="seeding-config" className="feature-card seeding-config" onSubmit={e => { e.preventDefault(); if (!locked && selectedIds.length) start(key); }}>
        <fieldset disabled={locked}>
          {tab === 'video-live' && <div className="seeding-modes" aria-label="Loại seeding">
            <button type="button" aria-pressed={mode === 'video'} className={`btn ${mode === 'video' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('video')}>Seeding Video</button>
            <button type="button" aria-pressed={mode === 'live'} className={`btn ${mode === 'live' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('live')}>Seeding Livestream</button>
          </div>}
        {tab === 'profile' && <div className="feature-file-picker"><h3>Ảnh đại diện</h3><div className="feature-toolbar"><button type="button" className="btn btn-secondary" onClick={() => selectFiles('folder')}>Chọn thư mục ảnh</button><button type="button" className="btn btn-secondary" onClick={() => selectFiles('image')}>Chọn từng ảnh</button></div><p>{value.avatarFiles?.length ? `${value.avatarFiles.length} ảnh đã chọn` : value.avatarFolder || 'Chưa chọn ảnh'}</p></div>}
        {tab === 'upload' && <div className="feature-file-picker"><div className="feature-toolbar"><h3>Hàng đợi video ({value.videos?.length || 0})</h3><button type="button" className="btn btn-secondary" onClick={() => selectFiles('video')}>Thêm video</button><button type="button" className="btn btn-secondary" onClick={() => set('videos', [])}>Xóa danh sách</button></div><p>Mỗi video được giao cho một tài khoản. Sản phẩm được ghép theo thứ tự trước khi chạy.</p>
          <div className="upload-queue">{(value.videos || []).map((v: any, i: number) => <article className="upload-queue-item" key={v.path}>
            <strong title={v.path}>{i + 1}. {v.title}</strong><small>{(Number(v.size) / 1024 / 1024).toFixed(1)} MB</small>
            <label className="feature-field"><span>Mô tả video {i + 1}</span><textarea rows={2} aria-label={'Mô tả video ' + (i + 1)} value={v.description} onChange={e => set('videos', value.videos.map((item: any, index: number) => index === i ? { ...item, description: e.target.value } : item))} /></label>
            {value.attachProducts && <small>Sản phẩm: {(typeof value.productLines === 'string' ? lines(value.productLines) : value.productLines || [])[i]?.split('|')[0] || 'Thiếu ID'}</small>}
            <div className="feature-toolbar"><button type="button" className="btn btn-secondary" disabled={i === 0} onClick={() => { const next = [...value.videos]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; set('videos', next); }}>↑ Đưa lên</button><button type="button" className="btn btn-secondary" onClick={() => set('videos', value.videos.filter((_: any, index: number) => index !== i))}>Xóa</button></div>
          </article>)}</div>
        </div>}
          <Fields fields={configs[key].fields} value={value} onChange={set} />
        </fieldset>
      </form>
      <section className="feature-card seeding-accounts" aria-label="Danh sách tài khoản thực hiện">
        <div className="feature-toolbar seeding-account-toolbar">
          <label className="seeding-category">Danh mục<select aria-label="Lọc nhóm" value={category} onChange={e => setCategory(e.target.value)}><option value="all">Tất cả danh mục</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <span className="seeding-count">Đã chọn <strong>{selectedIds.length}</strong> / {accounts.length}</span>
          <button className="btn btn-secondary" disabled={locked || !visible.length} onClick={() => setSelectedIds(old => allChecked ? old.filter(id => !visible.some(a => a.id === id)) : [...new Set([...old, ...visible.map(a => a.id)])])}>{allChecked ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => act(reload)}>Nạp lại</button>
          <div className="seeding-run-actions">
            <button form="seeding-config" type="submit" className="btn btn-primary" disabled={locked || !selectedIds.length}>{state.isRunning ? 'Đang chạy…' : 'Bắt đầu'}</button>
            <button className="btn btn-danger" disabled={busy || !state.isRunning} onClick={() => act(async () => { await invoke('cancel'); setState(await invoke('state')); })}>Dừng lại</button>
          </div>
        </div>
        <div className="seeding-search"><h3>Tài khoản thực hiện <small>({visible.length})</small></h3><input aria-label="Tìm tài khoản" placeholder="Tìm username, email, ghi chú…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="feature-table-scroll"><table><thead><tr>
          <th><input aria-label="Chọn tất cả tài khoản đang hiển thị" type="checkbox" checked={allChecked} disabled={locked} onChange={() => setSelectedIds(old => allChecked ? old.filter(id => !visible.some(a => a.id === id)) : [...new Set([...old, ...visible.map(a => a.id)])])} /></th><th>STT</th><th>Tài khoản</th><th>Trạng thái</th><th>Tiến trình trực tiếp</th>
        </tr></thead><tbody>{visible.map((a, index) => {
          const isSeeding = tab === 'video-live' ? state.command === 'video' || state.command === 'live' : state.command === tab;
          const event = isSeeding ? [...(state.events || [])].reverse().find((item: any) => item.accountId === a.id) : undefined;
          const result = isSeeding ? [...(state.results || [])].reverse().find((item: any) => item.accountId === a.id) : undefined;
          return <tr key={a.id} className={selectedIds.includes(a.id) ? 'seeding-selected' : ''}>
            <td><input aria-label={`Chọn ${a.username}`} type="checkbox" checked={selectedIds.includes(a.id)} disabled={locked} onChange={() => setSelectedIds(old => old.includes(a.id) ? old.filter(id => id !== a.id) : [...old, a.id])} /></td>
            <td>{index + 1}</td><td><strong>{a.username}</strong><small>{a.displayName || a.uid}</small></td><td>{a.status}</td><td className="seeding-account-progress">{(!state.isRunning && result?.message) || event?.message || result?.message || (selectedIds.includes(a.id) ? 'Chờ chạy…' : 'Chưa chọn')}{isSeeding && state.deviceCodes?.[a.id] && <div className="feature-notice">Mã kết nối Outlook: <strong>{String(state.deviceCodes[a.id])}</strong><button className="btn btn-secondary" onClick={() => act(() => invoke('microsoft'))}>Mở trang Microsoft</button></div>}{tab === 'upload' && isSeeding && (state.results || []).filter((item: any) => item.accountId === a.id && item.url).map((item: any, i: number) => <div key={i}><button className="btn btn-secondary" title={item.file || item.url} onClick={() => act(() => invoke('open-result', { url: item.url }))}>Mở video {i + 1}</button></div>)}</td>
          </tr>;
        })}</tbody></table>{!visible.length && <p className="feature-empty">{accounts.length ? 'Không có tài khoản phù hợp bộ lọc.' : 'Chưa có tài khoản. Thêm tài khoản ở Quản lý tài khoản.'}</p>}</div>
      </section>
    </div>
  </section>;
  return <section className="feature-workspace">
    <header className="feature-heading"><div><h2>{heading}</h2><p>Tự động hóa TikTok · {browser?.maxThreads || 4} luồng · {selectedIds.length} tài khoản đã chọn</p></div>
      <button className="btn btn-secondary" disabled={busy} onClick={() => act(reload)}>Tải lại tài khoản</button></header>
    {error && <div role="alert" className="feature-notice feature-error">{error}</div>}
    {message && <div role="status" className="feature-notice">{message}</div>}
    {tab !== 'browser-settings' && state.command && <div className={`feature-notice feature-toolbar ${state.success === false && !state.isRunning ? 'feature-error' : ''}`} role="status"><strong>{state.command}</strong><span>{state.message}</span>{state.isRunning && <button className="btn btn-danger" onClick={() => act(() => invoke('cancel'))}>Dừng tác vụ</button>}</div>}

    {tab !== 'browser-settings' && <section className="feature-card">
      <div className="feature-toolbar"><h3>Tài khoản thực hiện</h3><select aria-label="Lọc nhóm" value={category} onChange={e => setCategory(e.target.value)}><option value="all">Tất cả nhóm</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input aria-label="Tìm tài khoản" placeholder="Tìm username, email, ghi chú…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="feature-table-scroll"><table><thead><tr><th><input aria-label="Chọn tất cả tài khoản đang hiển thị" type="checkbox" checked={allChecked} disabled={locked} onChange={() => setSelectedIds(old => allChecked ? old.filter(id => !visible.some(a => a.id === id)) : [...new Set([...old, ...visible.map(a => a.id)])])} /></th><th>Username / UID</th><th>Tên hiển thị</th><th>Email</th><th>Trạng thái</th>{tab === 'tools' && <th>Sửa</th>}</tr></thead><tbody>{visible.map(a => <tr key={a.id}><td><input aria-label={`Chọn ${a.username}`} type="checkbox" checked={selectedIds.includes(a.id)} disabled={locked} onChange={() => setSelectedIds(old => old.includes(a.id) ? old.filter(id => id !== a.id) : [...old, a.id])} /></td><td>{a.username}<small>{a.uid}</small></td><td>{a.displayName}</td><td>{a.email}</td><td>{a.status}</td>{tab === 'tools' && <td><button className="btn btn-secondary" disabled={locked} onClick={() => setEdit({ ...a })}>Sửa</button></td>}</tr>)}</tbody></table>{!visible.length && <p className="feature-empty">Chưa có tài khoản trong danh sách. Thêm tài khoản ở Quản lý tài khoản.</p>}</div>
    </section>}

    {tab === 'browser-settings' && browser && <form className="feature-card" onSubmit={e => { e.preventDefault(); act(async () => { await invoke('settings', browser); setMessage('Đã lưu cài đặt chung.'); }); }}><fieldset disabled={locked}><Fields fields={browserFields} value={browser} onChange={(field, data) => setBrowser((old: any) => ({ ...old, [field]: data }))} /><button className="btn btn-primary feature-submit" type="submit">Lưu cài đặt</button></fieldset></form>}

    {tab === 'tools' && <>
      <section className="feature-card"><h3>Sao chép và đổi trạng thái</h3><div className="feature-toolbar">
        <select aria-label="Nội dung sao chép" value={copyFormat} onChange={e => setCopyFormat(e.target.value)}>{['UID', 'PASS', '2FA', 'COOKIE', 'PROXY', 'UID|PASS|2FA', 'UID|PASS|2FA|COOKIE|PROXY', 'UID|PASS|MAIL|PASSMAIL'].map(f => <option key={f}>{f}</option>)}</select>
        <button className="btn btn-secondary" disabled={!selectedIds.length} onClick={() => act(async () => { const r = await invoke('copy-accounts', { accountIds: selectedIds, format: copyFormat }); setMessage(`Đã sao chép ${r.count} tài khoản.`); })}>Sao chép tài khoản</button>
        <button className="btn btn-secondary" disabled={!selectedIds.length} onClick={() => act(async () => { const r = await invoke('copy-totp', { accountIds: selectedIds }); setMessage(`Đã sao chép mã 2FA của tài khoản đầu tiên; còn ${r.remaining} giây.`); })}>Sao chép mã 2FA 6 số</button>
        <select aria-label="Trạng thái mới" value={bulkStatus} onChange={e => setBulkStatus(e.target.value)}><option value="live">Live</option><option value="die">Die</option><option value="unauthenticated">Chưa chạy</option><option value="checkpoint">Checkpoint</option></select>
        <button className="btn btn-secondary" disabled={locked || !selectedIds.length} onClick={() => act(async () => { for (const id of selectedIds) { const response = await apiFetch(`${NEST_BASE_URL}/accounts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: bulkStatus }) }); const r = await response.json(); if (!r.success) throw new Error('Không đổi được trạng thái tài khoản.'); } await reload(); setMessage('Đã đổi trạng thái các tài khoản đã chọn.'); })}>Đổi trạng thái</button>
        <button className="btn btn-secondary" disabled={!proxyIds.length} onClick={() => act(async () => { const r = await invoke('copy-proxies', { proxyIds }); setMessage(`Đã sao chép ${r.count} proxy.`); })}>Sao chép proxy đã chọn</button>
      </div></section>
      <section className="feature-card"><h3>Đăng nhập và kết nối Outlook</h3><p>Đăng nhập bằng cookie, mật khẩu, 2FA và mã xác minh email.</p><div className="feature-toolbar"><button className="btn btn-primary" disabled={locked || !selectedIds.length} onClick={() => start('login')}>Mở Chrome / Đăng nhập</button><button className="btn btn-secondary" disabled={locked || !selectedIds.length} onClick={() => start('outlook')}>Kết nối Outlook</button><button className="btn btn-secondary" disabled={locked} onClick={() => act(async () => { await invoke('close-browsers', { accountIds: selectedIds }); setMessage('Đã đóng Chrome của bộ chạy.'); })}>Đóng Chrome đã chọn (trống = tất cả)</button></div></section>
      <section className="feature-card"><h3>Nhập / xuất tài khoản</h3><label className="feature-field"><span>Định dạng cột (phân cách bằng |)</span><input value={format} onChange={e => setFormat(e.target.value)} placeholder="UID|PASS|MAIL|PASSMAIL" /></label><p>Hỗ trợ UID, PASS, 2FA, COOKIE, TOKEN, MAIL, PASSMAIL, RECOVERYMAIL, PROXY, USERAGENT, NOTE.</p><label className="feature-field"><span>Dữ liệu nhập — mỗi dòng một tài khoản</span><textarea rows={5} value={importText} onChange={e => setImportText(e.target.value)} /></label><div className="feature-toolbar"><button className="btn btn-primary" disabled={locked || !importText.trim()} onClick={() => act(async () => { const r = await invoke('import-text', { text: importText, format, categoryId: category === 'all' ? undefined : category }); setImportText(''); setMessage(`Đã thêm ${r.added}, cập nhật ${r.updated} tài khoản.`); await reload(); })}>Nhập vào nhóm đang chọn</button><button className="btn btn-secondary" disabled={locked || !selectedIds.length} onClick={() => exportAccounts(false)}>Xuất TXT</button><button className="btn btn-secondary" disabled={locked || !selectedIds.length} onClick={() => exportAccounts(true)}>Xuất Excel</button></div></section>
      {edit && <form className="feature-card" onSubmit={e => { e.preventDefault(); act(async () => { const response = await apiFetch(`${NEST_BASE_URL}/accounts/${edit.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) }); const r = await response.json(); if (!r.success) throw new Error('Không lưu được tài khoản.'); setEdit(null); await reload(); setMessage('Đã lưu tài khoản.'); }); }}><h3>Sửa tài khoản: {edit.username}</h3><div className="feature-fields">{(['username', 'uid', 'displayName', 'password', 'email', 'passMail', 'twoFactor', 'cookie', 'token', 'recoveryMail', 'userAgent', 'bio', 'notes'] as const).map(field => <label className="feature-field" key={field}><span>{{ username: 'Username', uid: 'UID', displayName: 'Tên hiển thị', password: 'Mật khẩu', email: 'Email', passMail: 'Mật khẩu mail', twoFactor: 'Khóa 2FA', cookie: 'Cookies', token: 'Token', recoveryMail: 'Mail khôi phục', userAgent: 'User agent', bio: 'Tiểu sử', notes: 'Ghi chú' }[field]}</span><input type={['password', 'passMail', 'twoFactor', 'cookie', 'token'].includes(field) ? 'password' : 'text'} value={edit[field] || ''} onChange={e => setEdit({ ...edit, [field]: e.target.value })} /></label>)}</div><div className="feature-toolbar"><button type="submit" className="btn btn-primary" disabled={locked}>Lưu tài khoản</button><button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>Đóng</button></div></form>}
      <section className="feature-card"><div className="feature-toolbar"><h3>Kiểm tra và sửa proxy</h3><button className="btn btn-secondary" disabled={locked || !proxyIds.length} onClick={() => act(async () => { const r = await invoke('check-proxies', { proxyIds }); setMessage(r.results.map((p: any) => `${p.success ? 'Live' : 'Lỗi'}: ${p.message}`).join(' · ')); await reload(); })}>Kiểm tra proxy đã chọn</button><button className="btn btn-secondary" disabled={!proxyIds.length} onClick={() => { const text = proxies.filter(p => proxyIds.includes(p.id)).map(p => p.value).join('\n'); const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = 'proxies.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Xuất TXT</button></div><div className="feature-table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Chọn tất cả proxy" checked={proxies.length > 0 && proxies.every(p => proxyIds.includes(p.id))} onChange={e => setProxyIds(e.target.checked ? proxies.map(p => p.id) : [])} /></th><th>Proxy</th><th>Loại</th><th>Trạng thái</th><th>Sửa</th></tr></thead><tbody>{proxies.map(p => <tr key={p.id}><td><input type="checkbox" aria-label={`Chọn proxy ${p.label || p.id}`} checked={proxyIds.includes(p.id)} onChange={e => setProxyIds(old => e.target.checked ? [...old, p.id] : old.filter(id => id !== p.id))} /></td><td>{p.label || p.value.split('@').pop()?.split(':').slice(0, 2).join(':')}</td><td>{p.proxyType}</td><td>{p.status || 'untested'}</td><td><button className="btn btn-secondary" disabled={locked} onClick={() => setProxyEdit({ ...p })}>Sửa</button></td></tr>)}</tbody></table></div>{proxyEdit && <form className="feature-toolbar" onSubmit={e => { e.preventDefault(); act(async () => { const response = await apiFetch(`${NEST_BASE_URL}/accounts/proxies/${proxyEdit.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proxyEdit) }); const r = await response.json(); if (!r.success) throw new Error('Không lưu được proxy.'); setProxyEdit(null); await reload(); }); }}><input aria-label="Địa chỉ proxy" value={proxyEdit.value} onChange={e => setProxyEdit({ ...proxyEdit, value: e.target.value })} /><input aria-label="Nhãn proxy" value={proxyEdit.label || ''} onChange={e => setProxyEdit({ ...proxyEdit, label: e.target.value })} /><select aria-label="Loại proxy" value={proxyEdit.proxyType} onChange={e => setProxyEdit({ ...proxyEdit, proxyType: e.target.value as any })}><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select><button className="btn btn-primary" disabled={locked}>Lưu proxy</button><button type="button" className="btn btn-secondary" onClick={() => setProxyEdit(null)}>Đóng</button></form>}</section>
    </>}

    {tab !== 'browser-settings' && <section className="feature-card"><div className="feature-toolbar"><h3>Tiến trình {state.command && `· ${state.command}`}</h3><span role="status">{state.message || 'Chưa chạy tác vụ'}</span><button className="btn btn-danger" disabled={!state.isRunning} onClick={() => act(() => invoke('cancel'))}>Dừng tác vụ</button></div>
      {Object.entries(state.deviceCodes || {}).map(([id, code]) => <div className="feature-notice" key={id}>Kết nối Outlook cho {accounts.find(a => a.id === id)?.email}: <strong>{String(code)}</strong> <button className="btn btn-secondary" onClick={() => act(() => invoke('microsoft'))}>Mở trang Microsoft</button></div>)}
      {!!state.results?.length && <div className="feature-table-scroll"><table><thead><tr><th>Tài khoản</th><th>Video / kết quả</th><th>Trạng thái</th><th>Link</th></tr></thead><tbody>{state.results.map((r: any, i: number) => <tr key={i}><td>{accounts.find(a => a.id === r.accountId)?.username}</td><td>{r.file || r.message}</td><td>{r.success ? 'Hoàn tất' : 'Có lỗi'}</td><td>{r.url && <button className="btn btn-secondary" onClick={() => act(() => invoke('open-result', { url: r.url }))}>Mở video</button>}</td></tr>)}</tbody></table></div>}
      <div className="feature-log" aria-label="Nhật ký tác vụ">{(state.events || []).slice(-150).map((event: any, i: number) => <div key={i}><time>{new Date(event.at).toLocaleTimeString()}</time> <b>{accounts.find(a => a.id === event.accountId)?.username || ''}</b> {event.message}</div>)}</div>
    </section>}
  </section>;
}

