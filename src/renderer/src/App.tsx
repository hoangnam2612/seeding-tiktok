import React, { useEffect, useState, useRef, useMemo } from 'react';
import {
  IconUsers,
  IconGlobe,
  IconRocket,
  IconTerminal,
  IconPlus,
  IconUpload,
  IconPlay,
  IconStop,
  IconSearch,
  IconTrash,
  IconFolder,
  IconKey,
  IconMail,
  IconRefresh,
  IconVolumeMute,
  IconTiktok,
} from './components/Icons';
import { StatusBadge } from './components/StatusBadge';
import { ThemeToggle } from './components/ThemeToggle';
import { AccountCategory, TikTokAccount, ProxyEntry, TaskLogItem } from './types';
import { apiFetch, NEST_BASE_URL } from './utils/api';
import { computeVisibleSelection, toggleSelectAllVisible, toggleSelectId } from './utils/selection';

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

      openMultiAccountChromes: (
        accountIds: string[],
        maxThreads: number,
        accountsData: any[],
        muteBrowserAudio?: boolean
      ) => Promise<any>;
      closeAllBrowserWindows: () => Promise<any>;
      executeSeedingTask: (config: any, accounts: any[]) => Promise<any>;
      onSeedingStateChanged?: (
        callback: (state: { isRunning: boolean; canceled?: boolean; reason?: string }) => void
      ) => () => void;
      platform: string;
    };
  }
}

export default function App() {
  // Theme Management (Light / Dark)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
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
          msg +=
            `\n\nChi tiết các dòng bị bỏ qua (hiển thị tối đa 20 dòng đầu):\n` +
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
      alert('Vui lòng chọn tài khoản ở tab Quản lý tài khoản trước.');
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
      setSelectedProxyIds((prev) => prev.filter((proxyId) => proxyId !== id));
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
      setSelectedAccountIds((prev) => prev.filter((i) => i !== id));
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
      const acc = accounts.find((a) => a.id === id);
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
      const selectedAccObjects = accounts.filter((a) => selectedAccountIds.includes(a.id));
      const threadCount = maxThreads === 0 ? selectedAccountIds.length : maxThreads;
      await window.electronAPI.openMultiAccountChromes(
        selectedAccountIds,
        threadCount,
        selectedAccObjects,
        muteLoginBrowserAudio
      );
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

  const handleClearLogs = async () => {
    try {
      const res = await apiFetch(`${NEST_BASE_URL}/automation/logs`, { method: 'DELETE' });
      if (res.ok) {
        setLogs([]);
      }
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  };

  // Filter Accounts
  const filteredAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      const matchesCat = activeCategory === 'all' || acc.categoryId === activeCategory;
      const matchesSearch =
        acc.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
        acc.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (acc.notes || '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === 'all' || acc.status === statusFilter;
      return matchesCat && matchesSearch && matchesStatus;
    });
  }, [accounts, activeCategory, searchQuery, statusFilter]);

  // Precise Selection Calculations (Safe across search & category filters)
  const visibleAccountIds = useMemo(() => filteredAccounts.map((a) => a.id), [filteredAccounts]);
  const { isAllSelected: isAllVisibleAccountsSelected, isIndeterminate: isAccountsIndeterminate } = useMemo(
    () => computeVisibleSelection(selectedAccountIds, visibleAccountIds),
    [selectedAccountIds, visibleAccountIds]
  );

  const visibleProxyIds = useMemo(() => proxies.map((p) => p.id), [proxies]);
  const { isAllSelected: isAllVisibleProxiesSelected, isIndeterminate: isProxiesIndeterminate } = useMemo(
    () => computeVisibleSelection(selectedProxyIds, visibleProxyIds),
    [selectedProxyIds, visibleProxyIds]
  );

  return (
    <div className="app-root">
      {/* Header Bar */}
      <header className="app-header">
        <div className="brand-section">
          <div className="logo-badge">
            <IconTiktok size={20} color="#ffffff" />
          </div>
          <div className="brand-text">
            <div className="brand-title">
              TikTok Automation Studio
              <span className="brand-tag">Ops Pro</span>
            </div>
            <div className="brand-subtitle">Hệ Thống Quản Lý Đa Luồng & Seeding Tự Động</div>
          </div>
        </div>

        <div className="header-actions">
          {/* Quick Metrics */}
          <div className="header-metric">
            <span>Tài khoản:</span>
            <span className="header-metric-val">{accounts.length}</span>
          </div>
          <div className="header-metric">
            <span>Proxy:</span>
            <span className="header-metric-val">{proxies.length}</span>
          </div>

          {/* Nest Status */}
          <div className={`status-badge ${nestStatus ? 'online' : 'offline'}`}>
            <span className="status-dot"></span>
            <span>
              {loadingStatus ? 'Đang kết nối...' : nestStatus ? 'Backend Active' : 'Backend Offline'}
            </span>
          </div>

          {/* Theme Toggle Button */}
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="app-shell">
        {/* Sidebar Navigation */}
        <aside className="app-sidebar">
          <div className="sidebar-section-label">Menu Điều Hướng</div>
          <nav className="tab-bar">
            <button
              className={`tab-btn ${activeTab === 'accounts' ? 'active' : ''}`}
              onClick={() => setActiveTab('accounts')}
            >
              <div className="tab-btn-content">
                <span className="tab-btn-icon">
                  <IconUsers size={17} />
                </span>
                <span className="tab-btn-text">Quản Lý Tài Khoản</span>
              </div>
              <span className="tab-count-badge">{accounts.length}</span>
            </button>

            <button
              className={`tab-btn ${activeTab === 'proxies' ? 'active' : ''}`}
              onClick={() => setActiveTab('proxies')}
            >
              <div className="tab-btn-content">
                <span className="tab-btn-icon">
                  <IconGlobe size={17} />
                </span>
                <span className="tab-btn-text">Kho Proxy</span>
              </div>
              <span className="tab-count-badge">{proxies.length}</span>
            </button>

            <button
              className={`tab-btn ${activeTab === 'seeding' ? 'active' : ''}`}
              onClick={() => setActiveTab('seeding')}
            >
              <div className="tab-btn-content">
                <span className="tab-btn-icon">
                  <IconRocket size={17} />
                </span>
                <span className="tab-btn-text">Seeding Automation</span>
              </div>
            </button>

            <button
              className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              <div className="tab-btn-content">
                <span className="tab-btn-icon">
                  <IconTerminal size={17} />
                </span>
                <span className="tab-btn-text">Live Console</span>
              </div>
              <span className="tab-count-badge">{logs.length}</span>
            </button>
          </nav>
        </aside>

        {/* Main Content Container */}
        <main className="main-container">
          {/* =========================================================================
              TAB 1: ACCOUNTS MANAGEMENT
              ========================================================================= */}
          {activeTab === 'accounts' && (
            <div className="accounts-layout">
              {/* Category Sidebar */}
              <aside className="category-sidebar">
                <div className="category-sidebar-header">
                  <span className="category-title">Danh Mục Nhóm</span>
                  <button className="btn btn-secondary btn-sm" onClick={() => setIsAddCategoryOpen(true)}>
                    <IconPlus size={13} />
                    <span>Nhóm</span>
                  </button>
                </div>

                <div
                  className={`category-item ${activeCategory === 'all' ? 'active' : ''}`}
                  onClick={() => setActiveCategory('all')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    <IconFolder size={14} />
                    <span>Tất cả tài khoản</span>
                  </span>
                  <span className="category-count">{accounts.length}</span>
                </div>

                {categories.map((cat) => {
                  const count = accounts.filter((a) => a.categoryId === cat.id).length;
                  return (
                    <div
                      key={cat.id}
                      className={`category-item ${activeCategory === cat.id ? 'active' : ''}`}
                      onClick={() => setActiveCategory(cat.id)}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                        <span
                          className="category-dot"
                          style={{ background: cat.color || 'var(--primary)' }}
                        ></span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cat.name}
                        </span>
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
                    <button className="btn btn-primary" onClick={() => setIsBatchImportOpen(true)}>
                      <IconUpload size={15} />
                      <span>Nhập Hàng Loạt</span>
                    </button>
                    <button className="btn btn-secondary" onClick={() => setIsSingleAddOpen(true)}>
                      <IconPlus size={15} />
                      <span>Thêm Lẻ</span>
                    </button>

                    <div className="toolbar-divider"></div>

                    {/* Multi-Thread Chrome Launcher */}
                    <button className="btn btn-success" onClick={handleOpenMultiChromes}>
                      <IconPlay size={14} />
                      <span>Mở Chrome ({selectedAccountIds.length})</span>
                    </button>
                    <button className="btn btn-secondary btn-danger" onClick={handleCloseAllBrowserWindows}>
                      <IconStop size={14} />
                      <span>Đóng Trình Duyệt</span>
                    </button>

                    <div className="toolbar-divider"></div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                        Luồng:
                      </span>
                      <select
                        className="custom-input"
                        style={{ width: '95px', padding: '0.35rem 0.5rem', fontSize: '0.78rem' }}
                        value={maxThreads}
                        onChange={(e) => setMaxThreads(Number(e.target.value))}
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

                    <label className="checkbox-label" style={{ fontSize: '0.78rem' }}>
                      <input
                        type="checkbox"
                        className="checkbox-custom"
                        checked={muteLoginBrowserAudio}
                        onChange={(e) => setMuteLoginBrowserAudio(e.target.checked)}
                      />
                      <IconVolumeMute size={14} />
                      <span>Tắt tiếng</span>
                    </label>

                    <button className="btn btn-secondary" onClick={handleBulkCheckLive}>
                      <IconRefresh size={14} />
                      <span>Check Live</span>
                    </button>
                  </div>

                  <div className="toolbar-group">
                    {/* Search Input */}
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                      <input
                        type="text"
                        className="custom-input"
                        placeholder="Tìm username, tên, note..."
                        style={{ width: '190px', padding: '0.38rem 0.65rem 0.38rem 1.8rem', fontSize: '0.8rem' }}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      <span
                        style={{
                          position: 'absolute',
                          left: '0.55rem',
                          color: 'var(--text-subtle)',
                          display: 'flex',
                          pointerEvents: 'none',
                        }}
                      >
                        <IconSearch size={13} />
                      </span>
                    </div>

                    {/* Status Filter */}
                    <select
                      className="custom-input"
                      style={{ width: '135px', padding: '0.38rem 0.55rem', fontSize: '0.8rem' }}
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                    >
                      <option value="all">Tất cả trạng thái</option>
                      <option value="authenticated">Auth Session</option>
                      <option value="unauthenticated">Chưa Auth</option>
                      <option value="live">Live</option>
                      <option value="die">Die</option>
                      <option value="checkpoint">Checkpoint</option>
                    </select>
                  </div>
                </div>

                {/* Bulk Actions Banner (Shown when 1 or more accounts are selected) */}
                {selectedAccountIds.length > 0 && (
                  <div className="bulk-action-bar">
                    <div className="bulk-action-text">
                      <span className="bulk-count-badge">{selectedAccountIds.length}</span>
                      <span>tài khoản đã được chọn</span>
                    </div>

                    <div className="toolbar-group">
                      <select
                        className="custom-input"
                        style={{ width: '150px', padding: '0.35rem 0.6rem', fontSize: '0.78rem' }}
                        onChange={(e) => {
                          if (e.target.value) {
                            handleBulkMoveCategory(e.target.value);
                            e.target.value = '';
                          }
                        }}
                        defaultValue=""
                      >
                        <option value="" disabled>
                          📁 Chuyển vào nhóm...
                        </option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>

                      <button className="btn btn-secondary btn-sm" onClick={handleBulkCheckLive}>
                        <IconRefresh size={13} />
                        <span>Kiểm tra Live</span>
                      </button>

                      <button className="btn btn-danger btn-sm" onClick={handleBulkDelete}>
                        <IconTrash size={13} />
                        <span>Xóa ({selectedAccountIds.length})</span>
                      </button>

                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setSelectedAccountIds([])}
                      >
                        Bỏ chọn
                      </button>
                    </div>
                  </div>
                )}

                {/* Account Data Table */}
                <div className="table-wrapper">
                  <table className="account-table">
                    <thead>
                      <tr>
                        <th style={{ width: '38px', textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            className="checkbox-custom"
                            ref={(el) => {
                              if (el) el.indeterminate = isAccountsIndeterminate;
                            }}
                            checked={isAllVisibleAccountsSelected}
                            onChange={() =>
                              setSelectedAccountIds((prev) =>
                                toggleSelectAllVisible(prev, visibleAccountIds)
                              )
                            }
                          />
                        </th>
                        <th style={{ width: '45px' }}>STT</th>
                        <th>Tài Khoản</th>
                        <th>Nhóm</th>
                        <th>Trạng Thái</th>
                        <th>Cookie</th>
                        <th>Proxy</th>
                        <th>Ghi Chú</th>
                        <th style={{ textAlign: 'right', minWidth: '170px' }}>Hành Động</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAccounts.length === 0 ? (
                        <tr>
                          <td colSpan={9}>
                            <div className="empty-state">
                              <div className="empty-state-icon">📋</div>
                              <div className="empty-state-title">Chưa có tài khoản nào</div>
                              <div className="empty-state-desc">
                                Bấm <strong>"Nhập Hàng Loạt"</strong> hoặc <strong>"Thêm Lẻ"</strong> để thêm
                                danh sách tài khoản TikTok vào hệ thống.
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filteredAccounts.map((acc, idx) => {
                          const isSelected = selectedAccountIds.includes(acc.id);
                          const cat = categories.find((c) => c.id === acc.categoryId);
                          return (
                            <tr key={acc.id} className={isSelected ? 'selected' : ''}>
                              <td style={{ textAlign: 'center' }}>
                                <input
                                  type="checkbox"
                                  className="checkbox-custom"
                                  checked={isSelected}
                                  onChange={() =>
                                    setSelectedAccountIds((prev) => toggleSelectId(prev, acc.id))
                                  }
                                />
                              </td>
                              <td style={{ color: 'var(--text-subtle)', fontSize: '0.78rem' }}>{idx + 1}</td>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                  <div className="acc-avatar">
                                    {acc.username.charAt(0).toUpperCase()}
                                  </div>
                                  <div>
                                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                                      @{acc.username}
                                    </div>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                      {acc.displayName || 'Chưa đặt tên'}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <span className="badge-category">
                                  <span
                                    className="category-dot"
                                    style={{ background: cat?.color || 'var(--primary)' }}
                                  ></span>
                                  {cat?.name || 'Mặc Định'}
                                </span>
                              </td>
                              <td>
                                <StatusBadge status={acc.status} />
                              </td>
                              <td>
                                {acc.cookie ? (
                                  <span style={{ color: 'var(--accent-emerald)', fontSize: '0.75rem', fontWeight: 600 }}>
                                    ✓ Đã có
                                  </span>
                                ) : (
                                  <span style={{ color: 'var(--text-subtle)', fontSize: '0.75rem' }}>
                                    Chưa có
                                  </span>
                                )}
                              </td>
                              <td>
                                <span
                                  style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '0.75rem',
                                    color: acc.proxy ? 'var(--accent-cyan)' : 'var(--text-subtle)',
                                  }}
                                >
                                  {acc.proxy || 'None'}
                                </span>
                              </td>
                              <td style={{ color: 'var(--text-muted)', fontSize: '0.75rem', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {acc.notes || '-'}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <div style={{ display: 'inline-flex', gap: '0.3rem' }}>
                                  <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => handleOpenSingleChrome(acc)}
                                    title="Mở trình duyệt Chrome với tài khoản này"
                                  >
                                    <IconPlay size={12} />
                                    <span>Chrome</span>
                                  </button>
                                  <button
                                    className="btn-action-icon"
                                    style={{ color: 'var(--accent-purple)' }}
                                    onClick={() => handleTestGenerate2FA(acc)}
                                    title="Tính toán thử nghiệm mã 2FA TOTP 6 số"
                                  >
                                    <IconKey size={13} />
                                  </button>
                                  <button
                                    className="btn-action-icon"
                                    style={{ color: 'var(--accent-amber)' }}
                                    onClick={() => handleTestFetchOtp(acc)}
                                    title="Thử nghiệm đọc OTP 6 số từ hòm thư"
                                  >
                                    <IconMail size={13} />
                                  </button>
                                  <button
                                    className="btn-action-icon danger"
                                    onClick={() => handleDeleteAccount(acc.id)}
                                    title="Xóa tài khoản này"
                                  >
                                    <IconTrash size={13} />
                                  </button>
                                </div>
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

          {/* =========================================================================
              TAB 2: PROXY MANAGEMENT
              ========================================================================= */}
          {activeTab === 'proxies' && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(300px, 380px) 1fr',
                gap: '1rem',
                alignItems: 'start',
                minHeight: 0,
                flex: 1,
              }}
            >
              {/* Left Column: Import & Metrics */}
              <div className="card-panel">
                <div className="card-header">
                  <h3 className="card-title">
                    <span className="card-icon">
                      <IconGlobe size={18} />
                    </span>
                    Nhập Proxy Vào Kho
                  </h3>
                </div>

                <form onSubmit={handleProxyImport} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  <div className="input-group">
                    <label className="input-label">
                      <span>Danh sách proxy (mỗi dòng 1 proxy)</span>
                      <span className="input-hint">ip:port hoặc user:pass@ip:port</span>
                    </label>
                    <textarea
                      className="textarea-custom"
                      rows={6}
                      placeholder={`1.2.3.4:8080\nuser:pass@1.2.3.4:8080\n1.2.3.4:8080:user:pass`}
                      value={proxyImportText}
                      onChange={(e) => setProxyImportText(e.target.value)}
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label">Loại proxy</label>
                    <select
                      className="custom-input"
                      value={proxyImportType}
                      onChange={(e) => setProxyImportType(e.target.value as ProxyEntry['proxyType'])}
                    >
                      <option value="http">HTTP Proxy</option>
                      <option value="socks5">SOCKS5 Proxy</option>
                      <option value="tmproxy">TMProxy API Key</option>
                      <option value="tinsoft">Tinsoft API Key</option>
                    </select>
                  </div>

                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                    <IconUpload size={14} />
                    <span>Nhập Proxy Vào Kho</span>
                  </button>
                </form>

                {/* Metrics */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.65rem', marginTop: '0.35rem' }}>
                  <div
                    style={{
                      padding: '0.75rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-surface-subtle)',
                    }}
                  >
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                      Proxy trong kho
                    </div>
                    <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {proxies.length}
                    </div>
                  </div>
                  <div
                    style={{
                      padding: '0.75rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-surface-subtle)',
                    }}
                  >
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                      Tài khoản đã có proxy
                    </div>
                    <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--primary)' }}>
                      {accounts.filter((acc) => !!acc.proxy).length}
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column: Assign & Proxy Table */}
              <div className="card-panel" style={{ flex: 1 }}>
                <div className="card-header">
                  <h3 className="card-title">
                    <span className="card-icon">
                      <IconUsers size={18} />
                    </span>
                    Gán Proxy Cho Tài Khoản
                  </h3>
                </div>

                <div className="toolbar">
                  <div className="toolbar-group">
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      Đã chọn {selectedProxyIds.length} proxy & {selectedAccountIds.length} tài khoản
                    </span>

                    <select
                      className="custom-input"
                      style={{ width: '130px', padding: '0.35rem 0.5rem', fontSize: '0.78rem' }}
                      value={proxyAssignMode}
                      onChange={(e) => setProxyAssignMode(e.target.value as 'rotate' | 'one-to-one')}
                    >
                      <option value="rotate">Xoay vòng</option>
                      <option value="one-to-one">1 proxy / 1 acc</option>
                    </select>

                    <button className="btn btn-primary btn-sm" onClick={handleAssignSelectedProxies}>
                      Gán Proxy
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={handleClearSelectedAccountProxies}>
                      Gỡ Khỏi Acc Đã Chọn
                    </button>
                  </div>
                </div>

                <div className="table-wrapper" style={{ maxHeight: '420px' }}>
                  <table className="account-table">
                    <thead>
                      <tr>
                        <th style={{ width: '38px', textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            className="checkbox-custom"
                            ref={(el) => {
                              if (el) el.indeterminate = isProxiesIndeterminate;
                            }}
                            checked={isAllVisibleProxiesSelected}
                            onChange={() =>
                              setSelectedProxyIds((prev) =>
                                toggleSelectAllVisible(prev, visibleProxyIds)
                              )
                            }
                          />
                        </th>
                        <th>Địa Chỉ Proxy</th>
                        <th>Loại</th>
                        <th>Đang Gán Cho</th>
                        <th style={{ textAlign: 'right' }}>Hành Động</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proxies.length === 0 ? (
                        <tr>
                          <td colSpan={5}>
                            <div className="empty-state">
                              <div className="empty-state-icon">🌐</div>
                              <div className="empty-state-title">Chưa có proxy nào</div>
                              <div className="empty-state-desc">
                                Nhập danh sách proxy ở bảng bên trái để phân bổ cho tài khoản.
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        proxies.map((proxy) => {
                          const assignedAccounts = accounts.filter((acc) => acc.proxy === proxy.value);
                          return (
                            <tr
                              key={proxy.id}
                              className={selectedProxyIds.includes(proxy.id) ? 'selected' : ''}
                            >
                              <td style={{ textAlign: 'center' }}>
                                <input
                                  type="checkbox"
                                  className="checkbox-custom"
                                  checked={selectedProxyIds.includes(proxy.id)}
                                  onChange={() =>
                                    setSelectedProxyIds((prev) => toggleSelectId(prev, proxy.id))
                                  }
                                />
                              </td>
                              <td
                                style={{
                                  fontFamily: 'var(--font-mono)',
                                  color: 'var(--accent-cyan)',
                                  fontWeight: 600,
                                }}
                              >
                                {proxy.value}
                              </td>
                              <td>
                                <span className="badge-status authenticated">
                                  {proxy.proxyType.toUpperCase()}
                                </span>
                              </td>
                              <td>
                                {assignedAccounts.length > 0 ? (
                                  <span style={{ fontSize: '0.78rem' }}>
                                    {assignedAccounts
                                      .slice(0, 2)
                                      .map((acc) => `@${acc.username}`)
                                      .join(', ')}
                                    {assignedAccounts.length > 2
                                      ? ` +${assignedAccounts.length - 2}`
                                      : ''}
                                  </span>
                                ) : (
                                  <span style={{ color: 'var(--text-subtle)', fontSize: '0.75rem' }}>
                                    Chưa gán
                                  </span>
                                )}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <button
                                  className="btn-action-icon danger"
                                  onClick={() => handleDeleteProxy(proxy.id)}
                                  title="Xóa proxy"
                                >
                                  <IconTrash size={13} />
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

          {/* =========================================================================
              TAB 3: SEEDING AUTOMATION
              ========================================================================= */}
          {activeTab === 'seeding' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="card-panel">
                <div className="card-header">
                  <div>
                    <h3 className="card-title">
                      <span className="card-icon">
                        <IconRocket size={18} />
                      </span>
                      Cấu Hình Tác Vụ Seeding Automation
                    </h3>
                    <div className="card-subtitle">
                      Chạy tự động tương tác Like, Comment và Giữ Live đa luồng
                    </div>
                  </div>

                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                    Đã chọn: <span style={{ color: 'var(--primary)', fontWeight: 700 }}>{selectedAccountIds.length}</span> tài khoản
                  </div>
                </div>

                {/* Section 1: Target */}
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem' }}>
                  <div className="input-group">
                    <label className="input-label">
                      <span>Đường dẫn TikTok Target (Video hoặc Livestream)</span>
                    </label>
                    <input
                      type="text"
                      className="custom-input"
                      placeholder="https://www.tiktok.com/@user/video/123... hoặc /live"
                      value={targetUrl}
                      onChange={(e) => setTargetUrl(e.target.value)}
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label">Loại Target</label>
                    <div className="segmented-control">
                      <button
                        type="button"
                        className={`segmented-option ${targetType === 'video' ? 'active' : ''}`}
                        onClick={() => setTargetType('video')}
                      >
                        🎬 Video TikTok
                      </button>
                      <button
                        type="button"
                        className={`segmented-option ${targetType === 'livestream' ? 'active' : ''}`}
                        onClick={() => setTargetType('livestream')}
                      >
                        📡 Livestream
                      </button>
                    </div>
                  </div>
                </div>

                {/* Section 2: Actions & Settings */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: '1rem',
                    padding: '0.85rem',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-surface-subtle)',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  <div className="input-group">
                    <label className="input-label">Hành động tương tác</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.2rem' }}>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          className="checkbox-custom"
                          checked={likeEnabled}
                          onChange={(e) => setLikeEnabled(e.target.checked)}
                        />
                        <span>❤️ Thả tim (Like video / Tap Live liên tục)</span>
                      </label>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          className="checkbox-custom"
                          checked={muteBrowserAudio}
                          onChange={(e) => setMuteBrowserAudio(e.target.checked)}
                        />
                        <IconVolumeMute size={14} />
                        <span>Tắt âm thanh trình duyệt worker</span>
                      </label>
                    </div>
                  </div>

                  <div className="input-group">
                    <label className="input-label">
                      <span>Độ trễ giữa các tài khoản:</span>
                      <strong style={{ color: 'var(--primary)' }}>{delaySeconds}s</strong>
                    </label>
                    <input
                      type="range"
                      min={2}
                      max={30}
                      value={delaySeconds}
                      onChange={(e) => setDelaySeconds(Number(e.target.value))}
                      style={{ width: '100%', marginTop: '0.3rem' }}
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label">Số luồng chạy cùng lúc</label>
                    <select
                      className="custom-input"
                      value={seedingThreads}
                      onChange={(e) => setSeedingThreads(Number(e.target.value))}
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
                      <option value={0}>Tất cả tài khoản</option>
                    </select>
                  </div>

                  {targetType === 'livestream' && (
                    <div className="input-group">
                      <label className="input-label">Thời gian giữ Livestream (giây)</label>
                      <input
                        type="number"
                        className="custom-input"
                        min={10}
                        max={600}
                        step={5}
                        value={liveDurationSeconds}
                        onChange={(e) => setLiveDurationSeconds(Number(e.target.value))}
                      />
                    </div>
                  )}
                </div>

                {/* Section 3: OmoCaptcha */}
                <div className="input-group">
                  <label className="input-label">
                    <span>OmoCaptcha API Key (Tự động giải TikTok Web Captcha)</span>
                    <span className="input-hint">Slider / Rotate / 3D Select</span>
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.6rem' }}>
                    <input
                      type="password"
                      className="custom-input"
                      placeholder="Nhập OmoCaptcha Client Key..."
                      value={omocaptchaApiKey}
                      onChange={(e) => setOmocaptchaApiKey(e.target.value)}
                    />
                    <button type="button" className="btn btn-secondary" onClick={handleSaveOmocaptchaKey}>
                      Lưu Key
                    </button>
                  </div>
                </div>

                {/* Section 4: Comments */}
                <div className="input-group">
                  <label className="input-label">
                    <span>Kịch bản nội dung bình luận</span>
                    <span className="input-hint">Mỗi dòng là 1 bình luận ngẫu nhiên</span>
                  </label>
                  <textarea
                    className="textarea-custom"
                    rows={4}
                    value={commentsInput}
                    onChange={(e) => setCommentsInput(e.target.value)}
                    placeholder="Nhập nội dung bình luận..."
                  ></textarea>
                </div>

                {/* CTA Bar */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
                  <button
                    className="btn btn-primary"
                    style={{
                      padding: '0.85rem 1.5rem',
                      fontSize: '0.95rem',
                      fontWeight: 700,
                      width: '100%',
                    }}
                    disabled={isTaskExecuting}
                    onClick={async () => {
                      if (selectedAccountIds.length === 0) {
                        alert('Vui lòng chọn ít nhất 1 tài khoản ở Tab Quản Lý Tài Khoản trước khi chạy seeding!');
                        return;
                      }
                      setIsTaskExecuting(true);
                      setActiveTab('logs');
                      try {
                        if (window.electronAPI?.executeSeedingTask) {
                          const selectedAccs = accounts.filter((a) => selectedAccountIds.includes(a.id));
                          const seedingThreadCount =
                            seedingThreads === 0 ? selectedAccountIds.length : seedingThreads;
                          await window.electronAPI.executeSeedingTask(
                            {
                              targetUrl,
                              targetType,
                              accountIds: selectedAccountIds,
                              likeEnabled,
                              comments: commentsInput.split('\n').filter((c) => c.trim().length > 0),
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
                    <IconRocket size={18} />
                    <span>
                      {isTaskExecuting
                        ? 'Đang Khởi Chạy Tác Vụ Seeding...'
                        : `Bắt Đầu Seeding Ngay (${selectedAccountIds.length} Tài Khoản Đã Chọn)`}
                    </span>
                  </button>

                  {selectedAccountIds.length === 0 && (
                    <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--accent-amber)' }}>
                      ⚠️ Chưa chọn tài khoản nào. Vui lòng qua tab "Quản Lý Tài Khoản" để tick chọn tài khoản muốn chạy.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 4: LOGS CONSOLE
              ========================================================================= */}
          {activeTab === 'logs' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', flex: 1, minHeight: 0 }}>
              <div className="card-panel" style={{ flex: 1, minHeight: 0 }}>
                <div className="card-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <h3 className="card-title">
                      <span className="card-icon">
                        <IconTerminal size={18} />
                      </span>
                      Live Console Logs
                    </h3>
                    <span className="tab-count-badge">{logs.length} dòng</span>
                  </div>

                  <div className="toolbar-group">
                    <button className="btn btn-secondary btn-sm" onClick={handleClearLogs}>
                      <IconTrash size={13} />
                      <span>Xóa Nhật Ký</span>
                    </button>
                  </div>
                </div>

                <div className="terminal-window">
                  {logs.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-state-icon">🖥️</div>
                      <div className="empty-state-title">Chưa có nhật ký hoạt động nào</div>
                      <div className="empty-state-desc">
                        Khi bắt đầu tác vụ Seeding hoặc mở Chrome, các sự kiện real-time sẽ hiển thị ở đây.
                      </div>
                    </div>
                  ) : (
                    logs.map((log) => (
                      <div key={log.id} className="log-line">
                        <span className="log-time">[{log.timestamp}]</span>
                        <span className={`log-tag ${log.level}`}>{log.level}</span>
                        {log.accountUsername && (
                          <span className="log-user">[@{log.accountUsername}]:</span>
                        )}
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

      {/* =========================================================================
          MODAL 1: BATCH IMPORT ACCOUNTS
          ========================================================================= */}
      {isBatchImportOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsBatchImportOpen(false);
          }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <IconUpload size={18} />
                Nhập Tài Khoản Hàng Loạt
              </h3>
              <button className="modal-close" onClick={() => setIsBatchImportOpen(false)}>
                ✕
              </button>
            </div>

            <form
              onSubmit={handleBatchImport}
              style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}
            >
              <div className="input-group">
                <label className="input-label">Định dạng hỗ trợ tự động:</label>
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    background: 'var(--bg-surface-subtle)',
                    border: '1px solid var(--border-color)',
                    padding: '0.5rem 0.75rem',
                    borderRadius: 'var(--radius-sm)',
                    fontFamily: 'var(--font-mono)',
                    lineHeight: 1.5,
                  }}
                >
                  User | User|Pass | User|Pass|2FA | User|Pass|Cookie | User|Pass|Cookie|Proxy |
                  User|Pass|Cookie|Email|PassMail|2FA|Proxy
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">
                  <span>Dán danh sách dữ liệu (mỗi dòng 1 tài khoản):</span>
                </label>
                <textarea
                  ref={batchImportTextareaRef}
                  className="textarea-custom"
                  rows={6}
                  placeholder={`user_01|pass123|sessionid=abc;...|1.2.3.4:8080\nuser_02|pass456|sessionid=def;...|5.6.7.8:8080`}
                  value={batchRawText}
                  onChange={(e) => setBatchRawText(e.target.value)}
                  autoFocus
                  required
                ></textarea>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="input-group">
                  <label className="input-label">Lưu vào nhóm:</label>
                  <select
                    className="custom-input"
                    value={batchCategory}
                    onChange={(e) => setBatchCategory(e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="input-group">
                  <label className="input-label">Loại Proxy mặc định:</label>
                  <select
                    className="custom-input"
                    value={batchProxyType}
                    onChange={(e) => setBatchProxyType(e.target.value as any)}
                  >
                    <option value="http">HTTP Proxy</option>
                    <option value="socks5">SOCKS5 Proxy</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', marginTop: '0.4rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsBatchImportOpen(false)}
                >
                  Hủy Bỏ
                </button>
                <button type="submit" className="btn btn-primary">
                  <IconUpload size={14} />
                  <span>Bắt Đầu Nhập Dữ Liệu</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 2: SINGLE ADD ACCOUNT
          ========================================================================= */}
      {isSingleAddOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsSingleAddOpen(false);
          }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <IconPlus size={18} />
                Thêm Tài Khoản Lẻ
              </h3>
              <button className="modal-close" onClick={() => setIsSingleAddOpen(false)}>
                ✕
              </button>
            </div>

            <form
              onSubmit={handleSingleAddAccount}
              style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
            >
              <div className="input-group">
                <label className="input-label">Username TikTok (Bắt buộc):</label>
                <input
                  ref={singleAddInputRef}
                  type="text"
                  className="custom-input"
                  placeholder="Username (vd: user_test)"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="input-group">
                  <label className="input-label">Mật Khẩu (Tùy chọn):</label>
                  <input
                    type="password"
                    className="custom-input"
                    placeholder="Mật khẩu"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <div className="input-group">
                  <label className="input-label">Nhóm Tài Khoản:</label>
                  <select
                    className="custom-input"
                    value={newCategoryId}
                    onChange={(e) => setNewCategoryId(e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="input-group">
                  <label className="input-label">Email Hòm Thư (Tùy chọn):</label>
                  <input
                    type="email"
                    className="custom-input"
                    placeholder="user@hotmail.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </div>
                <div className="input-group">
                  <label className="input-label">PassMail (Đọc OTP tự động):</label>
                  <input
                    type="password"
                    className="custom-input"
                    placeholder="Mật khẩu email"
                    value={newPassMail}
                    onChange={(e) => setNewPassMail(e.target.value)}
                  />
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">Khóa 2FA Secret Key (Tự động tính mã TOTP 6 số):</label>
                <input
                  type="text"
                  className="custom-input"
                  placeholder="JBSWY3DPEHPK3PXP..."
                  value={newTwoFactor}
                  onChange={(e) => setNewTwoFactor(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Cookie String (Tùy chọn):</label>
                <input
                  type="text"
                  className="custom-input"
                  placeholder="sessionid=...; sid_tt=..."
                  value={newCookie}
                  onChange={(e) => setNewCookie(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Proxy (ip:port hoặc user:pass@ip:port):</label>
                <input
                  type="text"
                  className="custom-input"
                  placeholder="1.2.3.4:8080"
                  value={newProxy}
                  onChange={(e) => setNewProxy(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Ghi Chú:</label>
                <input
                  type="text"
                  className="custom-input"
                  placeholder="Ghi chú thêm..."
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', marginTop: '0.4rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsSingleAddOpen(false)}
                >
                  Hủy
                </button>
                <button type="submit" className="btn btn-primary">
                  <IconPlus size={14} />
                  <span>Lưu Tài Khoản</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 3: ADD CATEGORY
          ========================================================================= */}
      {isAddCategoryOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsAddCategoryOpen(false);
          }}
        >
          <div className="modal-content" style={{ maxWidth: '380px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <IconFolder size={18} />
                Thêm Nhóm Mới
              </h3>
              <button className="modal-close" onClick={() => setIsAddCategoryOpen(false)}>
                ✕
              </button>
            </div>

            <form
              onSubmit={handleAddCategory}
              style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}
            >
              <div className="input-group">
                <label className="input-label">Tên Nhóm / Danh Mục:</label>
                <input
                  ref={addCategoryInputRef}
                  type="text"
                  className="custom-input"
                  placeholder="VD: Nick Nuôi VIP..."
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsAddCategoryOpen(false)}
                >
                  Hủy
                </button>
                <button type="submit" className="btn btn-primary">
                  <IconPlus size={14} />
                  <span>Tạo Nhóm</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
