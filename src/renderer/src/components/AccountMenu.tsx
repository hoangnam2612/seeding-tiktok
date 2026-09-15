import React, { useEffect, useRef, useState } from 'react';
import { IconMoon, IconSun } from './Icons';

export function AccountMenu({ username, expiry, theme, onToggleTheme, onLogout }: {
  username: string; expiry: string; theme: 'light' | 'dark'; onToggleTheme: () => void; onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="account-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button type="button" className="account-menu-trigger" ref={trigger} aria-expanded={open} aria-controls="account-menu-panel" onClick={() => setOpen(value => !value)}>
      <span className="account-avatar" aria-hidden="true">{username.trim().charAt(0).toUpperCase() || 'U'}</span>
      <span className="account-menu-name" title={username}>{username}</span>
      <span aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
    {open && <div id="account-menu-panel" className="account-menu-panel" aria-label="Tùy chọn tài khoản">
      <div className="account-menu-expiry"><span>Hết hạn bản quyền</span><strong>{expiry}</strong></div>
      <button type="button" className="account-menu-item" onClick={onToggleTheme}>
        {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
        <span>{theme === 'dark' ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối'}</span>
      </button>
      <button type="button" className="account-menu-item account-menu-logout" onClick={() => { setOpen(false); onLogout(); }}>Đăng xuất</button>
    </div>}
  </div>;
}
