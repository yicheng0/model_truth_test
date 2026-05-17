import { useEffect, useState } from 'react';
import { getAdminApiKey, setAdminApiKey } from './api';

export function useAdminAccess() {
  const [adminKey, setAdminKeyState] = useState(() => getAdminApiKey());

  useEffect(() => {
    const onStorage = () => setAdminKeyState(getAdminApiKey());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  function updateAdminKey(value: string) {
    setAdminApiKey(value);
    setAdminKeyState(getAdminApiKey());
  }

  return {
    adminKey,
    isAdminMode: Boolean(adminKey),
    updateAdminKey,
  };
}
