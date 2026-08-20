import React from 'react';
import { IconSun, IconMoon } from './Icons';

interface ThemeToggleProps {
  theme: 'light' | 'dark';
  onToggle: () => void;
}

export const ThemeToggle: React.FC<ThemeToggleProps> = ({ theme, onToggle }) => {
  return (
    <button
      className="theme-toggle-btn"
      onClick={onToggle}
      title={theme === 'dark' ? 'Chuyển sang giao diện Sáng' : 'Chuyển sang giao diện Tối'}
      aria-label="Toggle Theme"
      type="button"
    >
      {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
    </button>
  );
};
