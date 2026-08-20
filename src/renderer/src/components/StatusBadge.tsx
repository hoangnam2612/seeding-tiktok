import React from 'react';
import { AccountStatus } from '../types';

interface StatusBadgeProps {
  status: AccountStatus;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className = '' }) => {
  const getStatusLabel = (s: AccountStatus) => {
    switch (s) {
      case 'authenticated':
        return '✓ Auth Session';
      case 'live':
        return 'Live';
      case 'die':
        return 'Die';
      case 'checkpoint':
        return 'Checkpoint';
      case 'error':
        return 'Lỗi';
      case 'active':
        return 'Active';
      case 'unauthenticated':
      default:
        return 'Chưa Auth';
    }
  };

  return (
    <span className={`badge-status ${status} ${className}`}>
      {getStatusLabel(status)}
    </span>
  );
};
