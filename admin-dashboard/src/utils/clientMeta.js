// Format desktop-client OS metadata for display in the Dashboard employee table.
// `os_platform` is Node's process.platform ('win32' | 'darwin' | 'linux' | ...),
// `os_version` is os.release() (e.g. '10.0.22631' on Windows, '23.6.0' on macOS).

const PLATFORM_LABEL = {
  win32:  'Windows',
  darwin: 'macOS',
  linux:  'Linux',
};

export function formatOs({ os_platform, os_version } = {}) {
  if (!os_platform && !os_version) return '—';
  const label = PLATFORM_LABEL[os_platform] || os_platform || '';
  return os_version ? `${label} ${os_version}`.trim() : label || '—';
}
