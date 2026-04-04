import { useEffect } from 'react';

export function useBodyScrollLock(isLocked) {
  useEffect(() => {
    if (isLocked) {
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => document.body.classList.remove('modal-open');
  }, [isLocked]);
}
