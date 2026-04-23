// Format desktop-client OS metadata for display in the Dashboard employee table.
// `os_platform` is Node's process.platform ('win32' | 'darwin' | 'linux' | ...),
// `os_version` is os.release() (e.g. '10.0.26200' on Windows, '23.6.0' on macOS).

export function formatOs({ os_platform, os_version } = {}) {
  if (!os_platform && !os_version) return '—';

  if (os_platform === 'win32') {
    // Windows 11 keeps the same NT kernel major as Windows 10 ("10.0.x"), so
    // os.release() alone can't tell them apart. Microsoft differentiates by
    // build number: builds < 22000 are Windows 10, >= 22000 are Windows 11.
    const parts = (os_version || '').split('.');
    const build = parseInt(parts[parts.length - 1] || '0', 10);
    if (!build) return 'Windows';
    const label = build >= 22000 ? 'Windows 11' : 'Windows 10';
    return `${label} (build ${build})`;
  }

  const PLATFORM_LABEL = { darwin: 'macOS', linux: 'Linux' };
  const label = PLATFORM_LABEL[os_platform] || os_platform;
  return os_version ? `${label} ${os_version}` : label;
}
