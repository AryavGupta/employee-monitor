const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function formatOs({ os_platform, os_version } = {}) {
  if (!os_platform) return '—';

  if (os_platform === 'win32') {
    // Windows 10 and Windows 11 share the NT 10 kernel, so os.release()
    // returns "10.0.x" for both. Microsoft uses the build number to split:
    // >= 22000 is Windows 11, below is Windows 10.
    const parts = (os_version || '').split('.');
    const build = parseInt(parts[parts.length - 1] || '0', 10);
    if (!build) return 'Windows';
    return build >= 22000 ? 'Windows 11' : 'Windows 10';
  }

  return PLATFORM_LABEL[os_platform] || os_platform;
}
