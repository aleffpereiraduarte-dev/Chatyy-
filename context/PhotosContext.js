import React, { createContext, useContext, useState, useRef, useEffect } from 'react';

const PhotosContext = createContext(null);

export function PhotosProvider({ children }) {
  // Persisted state - survives navigation
  const [devicePhotos, setDevicePhotos] = useState([]);
  const [cloudPhotos, setCloudPhotos] = useState([]);
  const [deviceTotalCount, setDeviceTotalCount] = useState(0);
  const [backedUpTotal, _setBackedUpTotal] = useState(0);
  const [storageInfo, _setStorageInfo] = useState(null);

  // Wrap setters to also cache values. Persiste 0/null pra não retornar
  // valor antigo após reset/clear; .catch externo evita unhandled rejection
  // no import dinâmico.
  const setBackedUpTotal = (val) => {
    _setBackedUpTotal(val);
    import('../services/cache').then(c => c.setCache('photos_backed_up_total', val, 7776000000)).catch(() => {});
  };
  const setStorageInfo = (val) => {
    _setStorageInfo(val);
    import('../services/cache').then(c => c.setCache('drive_storage_info', val, 7776000000)).catch(() => {});
  };

  // Load cached values on mount (instant) - photos render from cache immediately
  useEffect(() => {
    import('../services/cache').then(async (c) => {
      const cachedStorage = await c.getCached('drive_storage_info');
      if (cachedStorage) _setStorageInfo(cachedStorage);
      const cachedCount = await c.getCached('photos_backed_up_total');
      if (cachedCount) _setBackedUpTotal(cachedCount);
      // Restore cached cloud photos só se ainda não temos nada — antes
      // o closure capturava cloudPhotos vazio e podia sobrescrever fotos
      // recém carregadas se o import resolvesse depois.
      // P1 FIX (2026-05-21): photos.js writes to `cloud_photos_<email>` (it
      // user-namespaces the key on top of cache.js's per-user prefix because
      // PhotosContext mounts BEFORE auth hydrates and the cache prefix would
      // be wrong). Try both legacy `cloud_photos` and the namespaced fallback
      // — whichever the active user has. Without this fallback, hydration
      // here never matched what photos.js wrote and the grid always had to
      // wait for a fresh network fetch (visible empty flash + slow paint).
      let cachedPhotos = await c.getCached('cloud_photos');
      if (!cachedPhotos || cachedPhotos.length === 0) {
        try {
          const { getActiveAccountEmail } = require('../services/api');
          const email = (typeof getActiveAccountEmail === 'function' ? getActiveAccountEmail() : '') || '';
          if (email) cachedPhotos = await c.getCached(`cloud_photos_${email}`);
        } catch {}
      }
      if (cachedPhotos && cachedPhotos.length > 0) {
        setCloudPhotos(prev => (prev.length === 0 ? cachedPhotos : prev));
      }
    }).catch(() => {});
  }, []);
  const [backupStatus, setBackupStatus] = useState('idle');
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [lastBackupDate, setLastBackupDate] = useState(null);
  const [albums, setAlbums] = useState([]);
  const loadedRef = useRef(false); // true after first load

  return (
    <PhotosContext.Provider value={{
      devicePhotos, setDevicePhotos,
      cloudPhotos, setCloudPhotos,
      deviceTotalCount, setDeviceTotalCount,
      backedUpTotal, setBackedUpTotal,
      storageInfo, setStorageInfo,
      backupStatus, setBackupStatus,
      backupEnabled, setBackupEnabled,
      lastBackupDate, setLastBackupDate,
      albums, setAlbums,
      loadedRef,
    }}>
      {children}
    </PhotosContext.Provider>
  );
}

export function usePhotos() {
  return useContext(PhotosContext);
}
