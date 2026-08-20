import { useEffect, useState, useRef } from 'react';

declare global {
  interface Window {
    electronAPI?: {
      getDesktopMetadata: () => Promise<any>;
      getApiAuthToken: () => Promise<string>;
      focusWindow: () => Promise<any>;
      openAccountLoginWindow: (
        accountId: string,
        username: string,
        cookie?: string,
        proxy?: string,
        proxyType?: string,
        password?: string,
        email?: string,
        passMail?: string,
        twoFactor?: string,
        muteBrowserAudio?: boolean
      ) => Promise<any>;

      openMultiAccountChromes: (accountIds: string[], maxThreads: number, accountsData: any[], muteBrowserAudio?: boolean) => Promise<any>;
      closeAllBrowserWindows: () => Promise<any>;
      executeSeedingTask: (config: any, accounts: any[]) => Promise<any>;
      onSeedingStateChanged?: (callback: (state: { isRunning: boolean; canceled?: boolean; reason?: string }) => void) => () => void;
      platform: string;
    };
  }
}


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

export default function App() {
  const NEST_BASE_URL = 'http://127.0.0.1:3000/api';
  let cachedApiAuthToken = '';

  const getApiAuthToken = async () => {
    if (cachedApiAuthToken) return cachedApiAuthToken;
    cachedApiAuthToken = await window.electronAPI?.getApiAuthToken?.() || '';
    return cachedApiAuthToken;
  };

  const apiFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = await getApiAuthToken();
    const headers = new Headers(init.headers || {});
    if (token) headers.set('X-Seeding-App-Token', token);
    return fetch(input, { ...init, headers });
  };

  // Navigation State
  const [activeTab, setActiveTab] = useState<'accounts' | 'proxies' | 'seeding' | 'logs'>('accounts');

  // Server & System Status
  const [nestStatus, setNestStatus] = useState<any>(null);
  const [loadingStatus, setLoadingStatus] = useState<boolean>(true);

  // Categories & Accounts State
  const [categories, setCategories] = useState<AccountCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [accounts, setAccounts] = useState<TikTokAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [proxies, setProxies] = useState<ProxyEntry[]>([]);
  const [selectedProxyIds, setSelectedProxyIds] = useState<string[]>([]);
  
  // Search & Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Multi-Thread Execution State
  const [maxThreads, setMaxThreads] = useState<number>(10);
  const [muteLoginBrowserAudio, setMuteLoginBrowserAudio] = useState<boolean>(true);

  // Modals State
  const [isSingleAddOpen, setIsSingleAddOpen] = useState<boolean>(false);
  const [isBatchImportOpen, setIsBatchImportOpen] = useState<boolean>(false);
  const [isAddCategoryOpen, setIsAddCategoryOpen] = useState<boolean>(false);

  // Input Refs for Modal Focus Fix
  const singleAddInputRef = useRef<HTMLInputElement>(null);
  const batchImportTextareaRef = useRef<HTMLTextAreaElement>(null);
  const addCategoryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isSingleAddOpen) {
      window.electronAPI?.focusWindow();
      const timer = setTimeout(() => singleAddInputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isSingleAddOpen]);

  useEffect(() => {
    if (isBatchImportOpen) {
      window.electronAPI?.focusWindow();
      const timer = setTimeout(() => batchImportTextareaRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isBatchImportOpen]);

  useEffect(() => {
    if (isAddCategoryOpen) {
      window.electronAPI?.focusWindow();
      const timer = setTimeout(() => addCategoryInputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isAddCategoryOpen]);

  // Single Add Form
  const [newUsername, setNewUsername] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [newEmail, setNewEmail] = useState<string>('');
  const [newPassMail, setNewPassMail] = useState<string>('');
  const [newTwoFactor, setNewTwoFactor] = useState<string>('');
  const [newCookie, setNewCookie] = useState<string>('');
  const [newProxy, setNewProxy] = useState<string>('');
  const [newCategoryId, setNewCategoryId] = useState<string>('cat_default');
  const [newNotes, setNewNotes] = useState<string>('');



  // Batch Import Form
  const [batchRawText, setBatchRawText] = useState<string>('');
  const [batchCategory, setBatchCategory] = useState<string>('cat_default');
  const [batchProxyType, setBatchProxyType] = useState<TikTokAccount['proxyType']>('http');
  const [proxyImportText, setProxyImportText] = useState<string>('');
  const [proxyImportType, setProxyImportType] = useState<ProxyEntry['proxyType']>('http');
  const [proxyAssignMode, setProxyAssignMode] = useState<'rotate' | 'one-to-one'>('rotate');

  // Add Category Form
  const [newCategoryName, setNewCategoryName] = useState<string>('');

  // Seeding Task Form State
  const [targetUrl, setTargetUrl] = useState<string>('https://www.tiktok.com/@tiktok/video/73123456789');
  const [targetType, setTargetType] = useState<'video' | 'livestream'>('video');
  const [likeEnabled, setLikeEnabled] = useState<boolean>(true);
  const [commentsInput, setCommentsInput] = useState<string>(
    'Video tuyệt vời quá! 🔥\nĐã thả tim nha ❤️\nChất lượng quá ad ơi 👍'
  );
  const [delaySeconds, setDelaySeconds] = useState<number>(5);
  const [seedingThreads, setSeedingThreads] = useState<number>(5);
  const [liveDurationSeconds, setLiveDurationSeconds] = useState<number>(60);
  const [muteBrowserAudio, setMuteBrowserAudio] = useState<boolean>(true);
  const [omocaptchaApiKey, setOmocaptchaApiKey] = useState<string>('');
  const [isTaskExecuting, setIsTaskExecuting] = useState<boolean>(false);

  // Logs State
  const [logs, setLogs] = useState<TaskLogItem[]>([]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onSeedingStateChanged?.((state) => {
      setIsTaskExecuting(!!state.isRunning);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // --- FETCH DATA ---
  const fetchNestStatus = async () => {
    setLoadingStatus(true);
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/status`);
      if (res.ok) setNestStatus(await res.json());
      else setNestStatus(null);
    } catch {
      setNestStatus(null);
    } finally {
      setLoadingStatus(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/categories`);
      if (res.ok) {
        const json = await res.json();
        setCategories(json.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch categories:', err);
    }
  };

  const fetchAccounts = async () => {
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts`);
      if (res.ok) {
        const json = await res.json();
        setAccounts(json.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    }
  };

  const fetchProxies = async () => {
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/proxies`);
      if (res.ok) {
        const json = await res.json();
        setProxies(json.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch proxies:', err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/automation/logs`);
      if (res.ok) {
        const json = await res.json();
        setLogs(json.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/settings`);
      if (res.ok) {
        const json = await res.json();
        setOmocaptchaApiKey(json.data?.omocaptchaApiKey || '');
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  };

  useEffect(() => {
    fetchNestStatus();
    fetchCategories();
    fetchAccounts();
    fetchProxies();
    fetchSettings();
    fetchLogs();

    const interval = setInterval(() => {
      fetchAccounts();
      fetchLogs();
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  // --- HANDLERS ---
  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategoryName.trim()) return;

    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCategoryName }),
      });
      if (res.ok) {
        setNewCategoryName('');
        setIsAddCategoryOpen(false);
        fetchCategories();
      }
    } catch (err) {
      alert('Lỗi thêm danh mục');
    }
  };

  const handleSingleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) return;

    try {

      const res = await apiFetch(`${NEST_BASE_URL}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          email: newEmail,
          passMail: newPassMail,
          twoFactor: newTwoFactor,
          cookie: newCookie,
          proxy: newProxy,
          categoryId: newCategoryId,
          notes: newNotes,
        }),
      });
      if (res.ok) {
        setNewUsername('');
        setNewPassword('');
        setNewEmail('');
        setNewPassMail('');
        setNewTwoFactor('');
        setNewCookie('');
        setNewProxy('');
        setNewNotes('');
        setIsSingleAddOpen(false);
        fetchAccounts();
      }
    } catch (err) {
      alert('Lỗi thêm tài khoản');
    }
  };

  const handleTestGenerate2FA = async (acc: TikTokAccount) => {
    if (!acc.twoFactor) {
      alert('Tài khoản này chưa nhập Khóa Secret Key 2FA!');
      return;
    }
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/totp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ twoFactor: acc.twoFactor }),
      });
      const json = await res.json();
      if (json.success && json.code) {
        alert(`🔑 Mã 2FA TOTP 6 số tính toán tự động: [ ${json.code} ]`);
      } else {
        alert('⚠️ Không thể tính mã 2FA. Kiểm tra lại chuỗi Secret Key.');
      }
    } catch (err) {
      alert('Lỗi kết nối máy chủ 2FA');
    }
  };

  const handleTestFetchOtp = async (acc: TikTokAccount) => {
    const email = acc.email || acc.username;
    const passMail = acc.passMail;
    if (!email || !passMail) {
      alert('Tài khoản này chưa nhập đầy đủ Email và PassMail!');
      return;
    }
    alert(`⏳ Đang kết nối ngầm hòm thư ${email} để bóc tách mã OTP 6 số từ TikTok (chỉ đọc mail gần đây)...`);
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/fetch-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, passMail, requestedAt: Date.now() }),
      });
      const json = await res.json();
      if (json.success && json.otp) {
        alert(`🎉 Đọc thành công mã OTP mới từ TikTok: [ ${json.otp} ]`);
      } else {
        alert(`⚠️ Thông báo: ${json.message || 'Chưa tìm thấy mã OTP mới'}`);
      }
    } catch (err) {
      alert('Lỗi kết nối máy chủ đọc OTP');
    }
  };

  const handleBatchImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchRawText.trim()) return;

    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/batch-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawText: batchRawText,
          categoryId: batchCategory,
          proxyType: batchProxyType,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const { addedCount, updatedCount, skippedCount, skippedLines } = json.data || {};
        let msg = `✅ Kết quả Nhập Hàng Loạt:\n- Thêm mới: ${addedCount || 0} tài khoản\n- Cập nhật: ${updatedCount || 0} tài khoản\n- Bỏ qua (lỗi format): ${skippedCount || 0} dòng`;

        if (skippedLines && skippedLines.length > 0) {
          const displayLines = skippedLines.slice(0, 20);
          msg += `\n\nChi tiết các dòng bị bỏ qua (hiển thị tối đa 20 dòng đầu):\n` +
            displayLines.map((s: any) => `• Dòng ${s.line}: "${s.rawText}" (${s.reason})`).join('\n');
          if (skippedLines.length > 20) {
            msg += `\n... và ${skippedLines.length - 20} dòng khác.`;
          }
        }


        alert(msg);
        setBatchRawText('');
        setIsBatchImportOpen(false);
        fetchAccounts();
      }
    } catch (err) {
      alert('Lỗi nhập hàng loạt');
    }
  };

  const handleProxyImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!proxyImportText.trim()) return;

    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/proxies/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: proxyImportText, proxyType: proxyImportType }),
      });
      if (res.ok) {
        const json = await res.json();
        const data = json.data || {};
        alert(`Đã nhập ${data.addedCount || 0} proxy. Bỏ qua ${data.skippedCount || 0} dòng.`);
        setProxyImportText('');
        fetchProxies();
      }
    } catch (err) {
      alert('Lỗi nhập proxy');
    }
  };

  const handleSaveOmocaptchaKey = async () => {
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ omocaptchaApiKey }),
      });
      if (res.ok) {
        alert('Đã lưu OmoCaptcha API key.');
      }
    } catch (err) {
      alert('Lỗi lưu OmoCaptcha API key');
    }
  };

  const handleAssignSelectedProxies = async () => {
    if (selectedAccountIds.length === 0) {
      alert('Vui lòng chọn tài khoản ở tab Accounts trước.');
      return;
    }
    if (selectedProxyIds.length === 0) {
      alert('Vui lòng chọn proxy để gán.');
      return;
    }

    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/proxies/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountIds: selectedAccountIds,
          proxyIds: selectedProxyIds,
          mode: proxyAssignMode,
        }),
      });
      const json = await res.json();
      alert(`Đã gán proxy cho ${json.updatedCount || 0} tài khoản.`);
      fetchAccounts();
      fetchProxies();
    } catch (err) {
      alert('Lỗi gán proxy');
    }
  };

  const handleClearSelectedAccountProxies = async () => {
    if (selectedAccountIds.length === 0) {
      alert('Vui lòng chọn tài khoản cần bỏ proxy.');
      return;
    }
    if (!confirm(`Bỏ proxy khỏi ${selectedAccountIds.length} tài khoản đã chọn?`)) return;

    try {
      const res = await apiFetch(`${NEST_BASE_URL}/accounts/proxies/clear-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: selectedAccountIds }),
      });
      const json = await res.json();
      alert(`Đã bỏ proxy khỏi ${json.updatedCount || 0} tài khoản.`);
      fetchAccounts();
      fetchProxies();
    } catch (err) {
      alert('Lỗi bỏ proxy');
    }
  };

  const handleDeleteProxy = async (id: string) => {
    if (!confirm('Xóa proxy này khỏi kho proxy?')) return;
    try {
      await apiFetch(`${NEST_BASE_URL}/accounts/proxies/${id}`, { method: 'DELETE' });
      setSelectedProxyIds(selectedProxyIds.filter(proxyId => proxyId !== id));
      fetchAccounts();
      fetchProxies();
    } catch (err) {
      alert('Lỗi xóa proxy');
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (!confirm('Bạn có chắc chắn muốn xóa tài khoản này?')) return;
    try {
      await apiFetch(`${NEST_BASE_URL}/accounts/${id}`, { method: 'DELETE' });
      setSelectedAccountIds(selectedAccountIds.filter(i => i !== id));
      fetchAccounts();
    } catch (err) {
      alert('Lỗi xóa tài khoản');
    }
  };

  const handleBulkDelete = async () => {
    if (selectedAccountIds.length === 0) return;
    if (!confirm(`Xác nhận xóa ${selectedAccountIds.length} tài khoản đã chọn?`)) return;

    try {
      await apiFetch(`${NEST_BASE_URL}/accounts/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedAccountIds }),
      });
      setSelectedAccountIds([]);
      fetchAccounts();
    } catch (err) {
      alert('Lỗi xóa hàng loạt');
    }
  };

  const handleBulkMoveCategory = async (targetCatId: string) => {
    if (selectedAccountIds.length === 0) return;
    try {
      await apiFetch(`${NEST_BASE_URL}/accounts/bulk-move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedAccountIds, targetCategoryId: targetCatId }),
      });
      fetchAccounts();
    } catch (err) {
      alert('Lỗi di chuyển danh mục');
    }
  };

  const handleCheckLive = async (acc: TikTokAccount) => {
    try {
      await apiFetch(`${NEST_BASE_URL}/accounts/check-live/${acc.id}`, { method: 'POST' });
      fetchAccounts();
    } catch (err) {
      console.error(err);
    }
  };

  const handleBulkCheckLive = async () => {
    if (selectedAccountIds.length === 0) return;
    alert(`Đang tiến hành kiểm tra Live/Die cho ${selectedAccountIds.length} tài khoản...`);
    for (const id of selectedAccountIds) {
      const acc = accounts.find(a => a.id === id);
      if (acc) await handleCheckLive(acc);
    }
  };

  const handleOpenSingleChrome = async (acc: TikTokAccount) => {
    if (window.electronAPI?.openAccountLoginWindow) {
      await window.electronAPI.openAccountLoginWindow(
        acc.id,
        acc.username,
        acc.cookie,
        acc.proxy,
        acc.proxyType,
        acc.password,
        acc.email,
        acc.passMail,
        acc.twoFactor,
        muteLoginBrowserAudio
      );
    } else {
      alert('Chức năng mở Chrome yêu cầu ứng dụng Electron Desktop');
    }
  };




  const handleOpenMultiChromes = async () => {
    if (selectedAccountIds.length === 0) {
      alert('Vui lòng chọn ít nhất 1 tài khoản để mở Chrome!');
      return;
    }

    if (window.electronAPI?.openMultiAccountChromes) {
      const selectedAccObjects = accounts.filter(a => selectedAccountIds.includes(a.id));
      const threadCount = maxThreads === 0 ? selectedAccountIds.length : maxThreads;
      await window.electronAPI.openMultiAccountChromes(selectedAccountIds, threadCount, selectedAccObjects, muteLoginBrowserAudio);
    } else {
      alert('Chức năng mở Chrome Đa Luồng yêu cầu ứng dụng Electron Desktop');
    }
  };

  const handleCloseAllBrowserWindows = async () => {
    if (!window.electronAPI?.closeAllBrowserWindows) {
      alert('Chức năng đóng trình duyệt yêu cầu ứng dụng Electron Desktop');
      return;
    }

    const result = await window.electronAPI.closeAllBrowserWindows();
    setIsTaskExecuting(false);
    alert(`Đã đóng ${result?.closedCount || 0} trình duyệt.`);
  };

  const toggleSelectAccount = (id: string) => {
    if (selectedAccountIds.includes(id)) {
      setSelectedAccountIds(selectedAccountIds.filter(i => i !== id));
    } else {
      setSelectedAccountIds([...selectedAccountIds, id]);
    }
  };

  const toggleSelectAll = (filteredAccs: TikTokAccount[]) => {
    if (selectedAccountIds.length === filteredAccs.length) {
      setSelectedAccountIds([]);
    } else {
      setSelectedAccountIds(filteredAccs.map(a => a.id));
    }
  };

  const toggleSelectProxy = (id: string) => {
    if (selectedProxyIds.includes(id)) {
      setSelectedProxyIds(selectedProxyIds.filter(proxyId => proxyId !== id));
    } else {
      setSelectedProxyIds([...selectedProxyIds, id]);
    }
  };

  const toggleSelectAllProxies = () => {
    if (selectedProxyIds.length === proxies.length) {
      setSelectedProxyIds([]);
    } else {
      setSelectedProxyIds(proxies.map(proxy => proxy.id));
    }
  };

  // Filter Accounts
  const filteredAccounts = accounts.filter(acc => {
    const matchesCat = activeCategory === 'all' || acc.categoryId === activeCategory;
    const matchesSearch =
      acc.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
      acc.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (acc.notes || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || acc.status === statusFilter;
    return matchesCat && matchesSearch && matchesStatus;
  });

  return (
    <div className="app-root">
      {/* Header Bar */}
      <header className="app-header">
        <div className="brand-section">
          <div className="logo-icon">🎵</div>
          <div>
            <h1 className="brand-title">TikTok Multi-Thread Automation Studio</h1>
            <p className="brand-subtitle">Quản Lý Đa Luồng & Tương Tác Tự Động TikTok Studio</p>
          </div>
        </div>

        <div className="header-actions">
          <div className={`status-badge ${nestStatus ? 'online' : 'offline'}`}>
            <span className="status-dot"></span>
            <span>{loadingStatus ? 'Đang kết nối...' : nestStatus ? 'NestJS Backend Active' : 'Backend Offline'}</span>
          </div>
        </div>
      </header>

      <div className="app-shell">
        <aside className="app-sidebar">
          <div className="sidebar-section-label">Điều hướng</div>
          <nav className="tab-bar">
          <button
            className={`tab-btn ${activeTab === 'accounts' ? 'active' : ''}`}
            onClick={() => setActiveTab('accounts')}
          >
            <span>📋</span> Quản Lý Tài Khoản Đa Luồng ({accounts.length})
          </button>
          <button
            className={`tab-btn ${activeTab === 'proxies' ? 'active' : ''}`}
            onClick={() => setActiveTab('proxies')}
          >
            <span>🌐</span> Quản Lý Proxy ({proxies.length})
          </button>
          <button
            className={`tab-btn ${activeTab === 'seeding' ? 'active' : ''}`}
            onClick={() => setActiveTab('seeding')}
          >
            <span>🚀</span> Kịch Bản & Seeding Automation
          </button>
          <button
            className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            <span>📊</span> Live Console Logs ({logs.length})
          </button>
        </nav>
        </aside>

      {/* Main Container */}
      <main className="main-container">

        {/* TAB 1: ACCOUNTS MULTI-THREAD MANAGEMENT */}
        {activeTab === 'accounts' && (
          <div className="accounts-layout">
            {/* Category Sidebar */}
            <aside className="category-sidebar">
              <div className="category-sidebar-header">
                <span className="category-title">Danh Mục Nhóm</span>
                <button
                  className="btn-secondary"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => setIsAddCategoryOpen(true)}
                >
                  + Nhóm
                </button>
              </div>

              <div
                className={`category-item ${activeCategory === 'all' ? 'active' : ''}`}
                onClick={() => setActiveCategory('all')}
              >
                <span>🌐 Tất cả tài khoản</span>
                <span className="category-count">{accounts.length}</span>
              </div>

              {categories.map(cat => {
                const count = accounts.filter(a => a.categoryId === cat.id).length;
                return (
                  <div
                    key={cat.id}
                    className={`category-item ${activeCategory === cat.id ? 'active' : ''}`}
                    onClick={() => setActiveCategory(cat.id)}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: cat.color || '#3b82f6' }}></span>
                      {cat.name}
                    </span>
                    <span className="category-count">{count}</span>
                  </div>
                );
              })}
            </aside>

            {/* Main Accounts Area */}
            <div className="accounts-content">
              {/* Action Toolbar */}
              <div className="toolbar">
                <div className="toolbar-group">
                  <button className="btn-primary" onClick={() => setIsBatchImportOpen(true)}>
                    📥 Nhập Hàng Loạt
                  </button>
                  <button className="btn-secondary" onClick={() => setIsSingleAddOpen(true)}>
                    ➕ Thêm Lẻ
                  </button>

                  <div style={{ width: '1px', height: '24px', background: 'var(--border-color)', margin: '0 0.2rem' }}></div>

                  {/* Multi-Thread Chrome Launcher */}
                  <button
                    className="btn-primary"
                    style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }}
                    onClick={handleOpenMultiChromes}
                  >
                    🌐 Mở Chrome ({selectedAccountIds.length})
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ color: '#f43f5e' }}
                    onClick={handleCloseAllBrowserWindows}
                  >
                    Đóng tất cả trình duyệt
                  </button>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 700 }}>
                    Luồng
                  </span>
                  <select
                    className="custom-input"
                    style={{ width: '112px', padding: '0.45rem' }}
                    value={maxThreads}
                    onChange={e => setMaxThreads(Number(e.target.value))}
                  >
                    <option value={1}>1 Luồng</option>
                    <option value={2}>2 Luồng</option>
                    <option value={3}>3 Luồng</option>
                    <option value={4}>4 Luồng</option>
                    <option value={5}>5 Luồng</option>
                    <option value={6}>6 Luồng</option>
                    <option value={8}>8 Luồng</option>
                    <option value={10}>10 Luồng</option>
                    <option value={12}>12 Luồng</option>
                    <option value={0}>Tất cả</option>
                  </select>
                  <label className="checkbox-label" style={{ fontSize: '0.78rem', fontWeight: 700 }}>
                    <input
                      type="checkbox"
                      className="checkbox-custom"
                      checked={muteLoginBrowserAudio}
                      onChange={e => setMuteLoginBrowserAudio(e.target.checked)}
                    />
                    Tắt tiếng
                  </label>

                  <button className="btn-secondary" onClick={handleBulkCheckLive}>
                    🔍 Check Live
                  </button>
                </div>

                <div className="toolbar-group">
                  {/* Bulk Actions */}
                  {selectedAccountIds.length > 0 && (
                    <>
                      <select
                        className="custom-input"
                        style={{ width: '140px', padding: '0.45rem' }}
                        onChange={e => {
                          if (e.target.value) {
                            handleBulkMoveCategory(e.target.value);
                            e.target.value = '';
                          }
                        }}
                      >
                        <option value="">📁 Chuyển nhóm...</option>
                        {categories.map(c => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>

                      <button className="btn-secondary" style={{ color: '#f43f5e' }} onClick={handleBulkDelete}>
                        🗑️ Xóa ({selectedAccountIds.length})
                      </button>
                    </>
                  )}

                  {/* Search Input */}
                  <input
                    type="text"
                    className="custom-input"
                    placeholder="🔎 Tìm Username / Ghi chú..."
                    style={{ width: '180px', padding: '0.45rem 0.8rem' }}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />

                  {/* Status Filter */}
                  <select
                    className="custom-input"
                    style={{ width: '130px', padding: '0.45rem' }}
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                  >
                    <option value="all">Tất cả trạng thái</option>
                    <option value="authenticated">Auth Session</option>
                    <option value="unauthenticated">Chưa Auth</option>
                    <option value="live">Live</option>
                    <option value="die">Die</option>
                  </select>
                </div>
              </div>

              {/* Data Table */}
              <div className="table-wrapper">
                <table className="account-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>
                        <input
                          type="checkbox"
                          className="checkbox-custom"
                          checked={filteredAccounts.length > 0 && selectedAccountIds.length === filteredAccounts.length}
                          onChange={() => toggleSelectAll(filteredAccounts)}
                        />
                      </th>
                      <th>STT</th>
                      <th>Username</th>
                      <th>Nhóm</th>
                      <th>Trạng Thái</th>
                      <th>Cookie</th>
                      <th>Proxy</th>
                      <th>Ghi Chú</th>
                      <th style={{ textAlign: 'right' }}>Hành Động</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAccounts.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                          Chưa có tài khoản nào trong nhóm này. Hãy bấm <strong>"📥 Nhập Hàng Loạt"</strong> để bắt đầu.
                        </td>
                      </tr>
                    ) : (
                      filteredAccounts.map((acc, idx) => {
                        const isSelected = selectedAccountIds.includes(acc.id);
                        const cat = categories.find(c => c.id === acc.categoryId);
                        return (
                          <tr key={acc.id} className={isSelected ? 'selected' : ''}>
                            <td>
                              <input
                                type="checkbox"
                                className="checkbox-custom"
                                checked={isSelected}
                                onChange={() => toggleSelectAccount(acc.id)}
                              />
                            </td>
                            <td style={{ color: 'var(--text-muted)' }}>{idx + 1}</td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                <div className="acc-avatar" style={{ width: '32px', height: '32px', fontSize: '0.85rem' }}>
                                  {acc.username.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                  <div style={{ fontWeight: 700 }}>@{acc.username}</div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{acc.displayName}</div>
                                </div>
                              </div>
                            </td>
                            <td>
                              <span
                                style={{
                                  padding: '0.2rem 0.6rem',
                                  borderRadius: '6px',
                                  fontSize: '0.75rem',
                                  background: 'rgba(255,255,255,0.06)',
                                  border: `1px solid ${cat?.color || 'var(--border-color)'}`,
                                }}
                              >
                                {cat?.name || 'Mặc Định'}
                              </span>
                            </td>
                            <td>
                              <span className={`badge-status ${acc.status}`}>
                                {acc.status === 'authenticated'
                                  ? '✓ Auth Session'
                                  : acc.status === 'live'
                                  ? 'Live'
                                  : acc.status === 'die'
                                  ? 'Die'
                                  : 'Chưa Đăng Nhập'}
                              </span>
                            </td>
                            <td>
                              {acc.cookie ? (
                                <span style={{ color: '#34d399', fontSize: '0.8rem' }}>🔑 Cooie OK</span>
                              ) : (
                                <span style={{ color: '#64748b', fontSize: '0.8rem' }}>Chưa có</span>
                              )}
                            </td>
                            <td>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: '#38bdf8' }}>
                                {acc.proxy || 'None'}
                              </span>
                            </td>
                            <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{acc.notes || '-'}</td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                className="btn-secondary"
                                style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', marginRight: '0.4rem' }}
                                onClick={() => handleOpenSingleChrome(acc)}
                              >
                                🔑 Mở Chrome
                              </button>
                              <button
                                className="btn-secondary"
                                style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', marginRight: '0.4rem', color: '#a855f7' }}
                                onClick={() => handleTestGenerate2FA(acc)}
                                title="Tính toán thử nghiệm mã 2FA TOTP 6 số"
                              >
                                🔑 2FA
                              </button>
                              <button
                                className="btn-secondary"
                                style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', marginRight: '0.4rem', color: '#fbbf24' }}
                                onClick={() => handleTestFetchOtp(acc)}
                                title="Thử nghiệm đọc OTP 6 số từ hòm thư"
                              >
                                📬 OTP
                              </button>

                              <button
                                className="btn-secondary"
                                style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', color: '#f43f5e' }}
                                onClick={() => handleDeleteAccount(acc.id)}
                              >
                                🗑️
                              </button>
                            </td>

                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: PROXY MANAGEMENT */}
        {activeTab === 'proxies' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) 1fr', gap: '1.5rem', alignItems: 'start' }}>
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  <span className="card-icon">🌐</span> Kho Proxy
                </h3>
              </div>

              <form onSubmit={handleProxyImport} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="input-group">
                  <label className="input-label">Danh sách proxy, mỗi dòng 1 proxy</label>
                  <textarea
                    className="textarea-custom"
                    rows={8}
                    placeholder={`1.2.3.4:8080\nuser:pass@1.2.3.4:8080\n1.2.3.4:8080:user:pass`}
                    value={proxyImportText}
                    onChange={e => setProxyImportText(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label className="input-label">Loại proxy mặc định</label>
                  <select
                    className="custom-input"
                    value={proxyImportType}
                    onChange={e => setProxyImportType(e.target.value as ProxyEntry['proxyType'])}
                  >
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="tmproxy">TMProxy</option>
                    <option value="tinsoft">Tinsoft</option>
                  </select>
                </div>

                <button type="submit" className="btn-primary">
                  Nhập proxy vào kho
                </button>
              </form>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Proxy trong kho</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{proxies.length}</div>
                </div>
                <div style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Tài khoản đã có proxy</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{accounts.filter(acc => !!acc.proxy).length}</div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  <span className="card-icon">🔗</span> Gán Proxy Cho Tài Khoản
                </h3>
              </div>

              <div className="toolbar">
                <div className="toolbar-group">
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Đã chọn {selectedProxyIds.length} proxy và {selectedAccountIds.length} tài khoản
                  </span>
                  <select
                    className="custom-input"
                    style={{ width: '150px', padding: '0.45rem' }}
                    value={proxyAssignMode}
                    onChange={e => setProxyAssignMode(e.target.value as 'rotate' | 'one-to-one')}
                  >
                    <option value="rotate">Xoay vòng</option>
                    <option value="one-to-one">1 proxy / 1 acc</option>
                  </select>
                  <button className="btn-primary" onClick={handleAssignSelectedProxies}>
                    Gán proxy
                  </button>
                  <button className="btn-secondary" onClick={handleClearSelectedAccountProxies}>
                    Bỏ proxy khỏi acc đã chọn
                  </button>
                </div>
              </div>

              <div className="table-wrapper">
                <table className="account-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>
                        <input
                          type="checkbox"
                          className="checkbox-custom"
                          checked={proxies.length > 0 && selectedProxyIds.length === proxies.length}
                          onChange={toggleSelectAllProxies}
                        />
                      </th>
                      <th>Proxy</th>
                      <th>Loại</th>
                      <th>Đang gán cho</th>
                      <th style={{ textAlign: 'right' }}>Hành Động</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proxies.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                          Chưa có proxy nào. Hãy nhập danh sách proxy ở khung bên trái.
                        </td>
                      </tr>
                    ) : (
                      proxies.map(proxy => {
                        const assignedAccounts = accounts.filter(acc => acc.proxy === proxy.value);
                        return (
                          <tr key={proxy.id} className={selectedProxyIds.includes(proxy.id) ? 'selected' : ''}>
                            <td>
                              <input
                                type="checkbox"
                                className="checkbox-custom"
                                checked={selectedProxyIds.includes(proxy.id)}
                                onChange={() => toggleSelectProxy(proxy.id)}
                              />
                            </td>
                            <td style={{ fontFamily: 'var(--font-mono)', color: '#38bdf8' }}>{proxy.value}</td>
                            <td>
                              <span className="badge-status authenticated">{proxy.proxyType.toUpperCase()}</span>
                            </td>
                            <td>
                              {assignedAccounts.length > 0 ? (
                                <span>
                                  {assignedAccounts.slice(0, 2).map(acc => `@${acc.username}`).join(', ')}
                                  {assignedAccounts.length > 2 ? ` +${assignedAccounts.length - 2}` : ''}
                                </span>
                              ) : (
                                <span style={{ color: 'var(--text-muted)' }}>Chưa gán</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                className="btn-secondary"
                                style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', color: '#f43f5e' }}
                                onClick={() => handleDeleteProxy(proxy.id)}
                              >
                                Xóa
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: SEEDING AUTOMATION */}
        {activeTab === 'seeding' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  <span className="card-icon">⚡</span> Cấu Hình Tác Vụ Seeding Automation
                </h3>
              </div>

              <div className="input-group">
                <label className="input-label">Link Target TikTok (Video hoặc Livestream):</label>
                <input
                  type="text"
                  className="custom-input"
                  placeholder="https://www.tiktok.com/@user/video/123... hoặc /live"
                  value={targetUrl}
                  onChange={e => setTargetUrl(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Loại Target:</label>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <label className="checkbox-label">
                    <input
                      type="radio"
                      name="targetType"
                      checked={targetType === 'video'}
                      onChange={() => setTargetType('video')}
                    />
                    🎬 Video TikTok
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="radio"
                      name="targetType"
                      checked={targetType === 'livestream'}
                      onChange={() => setTargetType('livestream')}
                    />
                    📡 TikTok Livestream
                  </label>
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">Hành động Seeding:</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      className="checkbox-custom"
                      checked={likeEnabled}
                      onChange={e => setLikeEnabled(e.target.checked)}
                    />
                    ❤️ Thả tim (Like video / Tap Live liên tục)
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      className="checkbox-custom"
                      checked={muteBrowserAudio}
                      onChange={e => setMuteBrowserAudio(e.target.checked)}
                    />
                    Tắt âm thanh trình duyệt worker
                  </label>
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">OmoCaptcha API Key (TikTok Web captcha)</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.75rem' }}>
                  <input
                    type="password"
                    className="custom-input"
                    placeholder="Nhập OmoCaptcha clientKey"
                    value={omocaptchaApiKey}
                    onChange={e => setOmocaptchaApiKey(e.target.value)}
                  />
                  <button type="button" className="btn-secondary" onClick={handleSaveOmocaptchaKey}>
                    Lưu key
                  </button>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  App sẽ tự thử giải TikTok Slider / Rotate / Select Object / 3D Select Object Web captcha bằng OmoCaptcha khi gặp màn hình xác minh.
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">Danh sách Nội dung Bình luận (Mỗi dòng là 1 comment ngẫu nhiên):</label>
                <textarea
                  className="textarea-custom"
                  rows={4}
                  value={commentsInput}
                  onChange={e => setCommentsInput(e.target.value)}
                  placeholder="Nhập nội dung bình luận..."
                ></textarea>
              </div>

              <div className="input-group">
                <label className="input-label">Thời gian trễ giữa các tài khoản: {delaySeconds} giây</label>
                <input
                  type="range"
                  min={2}
                  max={30}
                  value={delaySeconds}
                  onChange={e => setDelaySeconds(Number(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Số luồng seeding chạy cùng lúc:</label>
                <select
                  className="custom-input"
                  value={seedingThreads}
                  onChange={e => setSeedingThreads(Number(e.target.value))}
                >
                  <option value={1}>1 Luồng</option>
                  <option value={2}>2 Luồng</option>
                  <option value={3}>3 Luồng</option>
                  <option value={4}>4 Luồng</option>
                  <option value={5}>5 Luồng</option>
                  <option value={6}>6 Luồng</option>
                  <option value={8}>8 Luồng</option>
                  <option value={10}>10 Luồng</option>
                  <option value={12}>12 Luồng</option>
                  <option value={0}>Tất cả</option>
                </select>
              </div>

              <div className="input-group">
                <label className="input-label">Thời gian giữ Livestream: {liveDurationSeconds} giây</label>
                <input
                  type="number"
                  className="custom-input"
                  min={10}
                  max={600}
                  step={5}
                  value={liveDurationSeconds}
                  onChange={e => setLiveDurationSeconds(Number(e.target.value))}
                />
              </div>

              <button
                className="btn-primary"
                style={{ marginTop: '1rem', padding: '1rem', fontSize: '1rem' }}
                disabled={isTaskExecuting}
                onClick={async () => {
                  if (selectedAccountIds.length === 0) {
                    alert('Vui lòng chọn ít nhất 1 tài khoản ở Tab 1!');
                    return;
                  }
                  setIsTaskExecuting(true);
                  setActiveTab('logs');
                  try {
                    if (window.electronAPI?.executeSeedingTask) {
                      const selectedAccs = accounts.filter(a => selectedAccountIds.includes(a.id));
                      const seedingThreadCount = seedingThreads === 0 ? selectedAccountIds.length : seedingThreads;
                      await window.electronAPI.executeSeedingTask(
                        {
                          targetUrl,
                          targetType,
                          accountIds: selectedAccountIds,
                          likeEnabled,
                          comments: commentsInput.split('\n').filter(c => c.trim().length > 0),
                          delaySeconds,
                          maxThreads: seedingThreadCount,
                          liveDurationSeconds,
                          muteBrowserAudio,
                        },
                        selectedAccs
                      );
                    }
                  } catch (err) {
                    console.error('Seeding task failed:', err);
                    alert('Tác vụ Seeding đã dừng hoặc gặp lỗi. Vui lòng kiểm tra nhật ký để biết chi tiết.');
                  } finally {
                    setIsTaskExecuting(false);
                  }
                }}
              >
                {isTaskExecuting ? '⏳ Đang khởi chạy Seeding...' : '🚀 Bắt đầu Seeding ngay (' + selectedAccountIds.length + ' Acc)'}
              </button>
            </div>
          </div>
        )}

        {/* TAB 3: LOGS CONSOLE */}
        {activeTab === 'logs' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  <span className="card-icon">🖥️</span> Nhật Ký Hoạt Động Real-time
                </h3>
              </div>

              <div className="terminal-window">
                {logs.length === 0 ? (
                  <div style={{ color: '#64748b', textAlign: 'center', padding: '3rem' }}>
                    Chưa có nhật ký nào. Hãy khởi chạy tác vụ Seeding hoặc Mở Chrome!
                  </div>
                ) : (
                  logs.map(log => (
                    <div key={log.id} className="log-line">
                      <span className="log-time">[{log.timestamp}]</span>
                      <span className={`log-tag ${log.level}`}>{log.level}</span>
                      {log.accountUsername && <span className="log-user">[@{log.accountUsername}]:</span>}
                      <span className="log-msg">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </main>
      </div>

      {/* MODAL 1: BATCH IMPORT ACCOUNTS */}
      {isBatchImportOpen && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setIsBatchImportOpen(false); }}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">📥 Nhập Tài Khoản Hàng Loạt</h3>
              <button className="modal-close" onClick={() => setIsBatchImportOpen(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleBatchImport} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="input-group">
                <label className="input-label">Định dạng hỗ trợ tự động:</label>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', background: 'rgba(0,0,0,0.3)', padding: '0.6rem', borderRadius: '8px', fontFamily: 'var(--font-mono)' }}>
                  User<br />
                  User|Pass<br />
                  User|Pass|2FA<br />
                  User|Pass|Cookie<br />
                  User|Pass|2FA|Proxy<br />
                  User|Pass|Cookie|Proxy<br />
                  User|Pass|Cookie|Email|PassMail<br />
                  User|Pass|Cookie|Email|PassMail|2FA<br />
                  User|Pass|Cookie|Email|PassMail|2FA|Proxy


                </div>
              </div>

              <div className="input-group">
                <label className="input-label">Dán danh sách dữ liệu (mỗi dòng 1 tài khoản):</label>
                <textarea
                  ref={batchImportTextareaRef}
                  className="textarea-custom"
                  rows={6}
                  placeholder={`user_01|pass123|sessionid=abc;...|1.2.3.4:8080\nuser_02|pass456|sessionid=def;...|5.6.7.8:8080`}
                  value={batchRawText}
                  onChange={e => setBatchRawText(e.target.value)}
                  autoFocus
                  required
                ></textarea>
              </div>


              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div className="input-group">
                  <label className="input-label">Lưu vào nhóm:</label>
                  <select
                    className="custom-input"
                    value={batchCategory}
                    onChange={e => setBatchCategory(e.target.value)}
                  >
                    {categories.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="input-group">
                  <label className="input-label">Loại Proxy:</label>
                  <select
                    className="custom-input"
                    value={batchProxyType}
                    onChange={e => setBatchProxyType(e.target.value as any)}
                  >
                    <option value="http">HTTP Proxy</option>
                    <option value="socks5">SOCKS5 Proxy</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.8rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setIsBatchImportOpen(false)}>
                  Hủy Bỏ
                </button>
                <button type="submit" className="btn-primary">
                  Bắt Đầu Nhập Dữ Liệu
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: SINGLE ADD ACCOUNT */}
      {isSingleAddOpen && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setIsSingleAddOpen(false); }}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">➕ Thêm Tài Khoản Lẻ</h3>
              <button className="modal-close" onClick={() => setIsSingleAddOpen(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleSingleAddAccount} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <div className="input-group">
                <label className="input-label">Username TikTok:</label>
                <input
                  ref={singleAddInputRef}
                  type="text"
                  className="custom-input"
                  placeholder="Username (vd: user_test)"
                  value={newUsername}
                  onChange={e => setNewUsername(e.target.value)}
                  autoFocus
                  required
                />
              </div>


              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
                <div className="input-group">
                  <label className="input-label">Mật Khẩu (Tùy chọn):</label>
                  <input
                    type="password"
                    className="custom-input"
                    placeholder="Mật khẩu"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                  />
                </div>
                <div className="input-group">
                  <label className="input-label">Nhóm Tài Khoản:</label>
                  <select
                    className="custom-input"
                    value={newCategoryId}
                    onChange={e => setNewCategoryId(e.target.value)}
                  >
                    {categories.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
                <div className="input-group">
                  <label className="input-label">Email Hòm Thư (Tùy chọn):</label>
                  <input
                    type="email"
                    className="custom-input"
                    placeholder="user@hotmail.com"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                  />
                </div>
                <div className="input-group">
                  <label className="input-label">PassMail (Đọc OTP tự động):</label>
                  <input
                    type="password"
                    className="custom-input"
                    placeholder="Mật khẩu email"
                    value={newPassMail}
                    onChange={e => setNewPassMail(e.target.value)}
                  />
                </div>
              </div>


              <div className="input-group">
                <label className="input-label">Khóa 2FA Secret Key (Tự động sinh OTP 6 số):</label>
                <input
                  type="text"
                  className="custom-input"
                  placeholder="JBSWY3DPEHPK3PXP..."
                  value={newTwoFactor}
                  onChange={e => setNewTwoFactor(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Cookie String (Tùy chọn):</label>

                <input
                  type="text"
                  className="custom-input"
                  placeholder="sessionid=...; sid_tt=..."
                  value={newCookie}
                  onChange={e => setNewCookie(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Proxy (ip:port hoặc user:pass@ip:port):</label>
                <input
                  type="text"
                  className="custom-input"
                  placeholder="1.2.3.4:8080"
                  value={newProxy}
                  onChange={e => setNewProxy(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Ghi Chú:</label>
                <input
                  type="text"
                  className="custom-input"
                  placeholder="Ghi chú thêm"
                  value={newNotes}
                  onChange={e => setNewNotes(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.8rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setIsSingleAddOpen(false)}>
                  Hủy
                </button>
                <button type="submit" className="btn-primary">
                  Lưu Tài Khoản
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: ADD CATEGORY */}
      {isAddCategoryOpen && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setIsAddCategoryOpen(false); }}>
          <div className="modal-content" style={{ maxWidth: '400px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">📁 Thêm Nhóm Mới</h3>
              <button className="modal-close" onClick={() => setIsAddCategoryOpen(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleAddCategory} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="input-group">
                <label className="input-label">Tên Nhóm / Danh Mục:</label>
                <input
                  ref={addCategoryInputRef}
                  type="text"
                  className="custom-input"
                  placeholder="VD: Nick Nuôi VIP"
                  value={newCategoryName}
                  onChange={e => setNewCategoryName(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.8rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setIsAddCategoryOpen(false)}>
                  Hủy
                </button>
                <button type="submit" className="btn-primary">
                  Tạo Nhóm
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
