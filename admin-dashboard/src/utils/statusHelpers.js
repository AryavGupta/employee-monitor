// Centralized presence-status mapping. Use everywhere a user's effective_status
// is rendered so the badge label/color stays consistent across Dashboard, Teams,
// LiveMonitor, UserActivity, and any future surfaces.
//
// Status values match what /api/presence/* returns in `effective_status`:
//   online       → user has fresh heartbeat AND recent non-idle activity
//   idle         → fresh heartbeat but no recent activity (or client said idle)
//   disconnected → had a session but heartbeat is stale (used by per-session views)
//   offline      → no fresh heartbeat
//   logged_out   → explicit shift-end signal from the desktop app

export const STATUS_COLORS = {
  online: '#22c55e',
  idle: '#f59e0b',
  disconnected: '#dc2626',
  offline: '#6b7280',
  logged_out: '#94a3b8'
};

export const STATUS_LABELS = {
  online: 'Active',
  idle: 'Idle',
  disconnected: 'Disconnected',
  offline: 'Offline',
  logged_out: 'Logged Out'
};

export const STATUS_CLASS_NAMES = {
  online: 'badge-active',
  idle: 'badge-idle',
  disconnected: 'badge-disconnected',
  offline: 'badge-offline',
  logged_out: 'badge-logged-out'
};

const STATUS_ICONS = {
  online: '🟢',
  idle: '🟡',
  disconnected: '🔴',
  offline: '⚫',
  logged_out: '⚪'
};

export function getStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.offline;
}

export function getStatusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.offline;
}

export function getStatusClassName(status) {
  return STATUS_CLASS_NAMES[status] || STATUS_CLASS_NAMES.offline;
}

export function getStatusIcon(status) {
  return STATUS_ICONS[status] || STATUS_ICONS.offline;
}
