import React, { createContext, useContext, useState, useRef, useEffect } from 'react';

const PhotosContext = createContext(null);

export function PhotosProvider({ children }) {
  // Persisted state - survives navigation
  const [devicePhotos, setDevicePhotos] = useState([]);
  const [cloudPhotos, setCloudPhotos] = useState([]);
  const [deviceTotalCount, setDeviceTotalCount] = useState(0);
  const [backedUpTotal, _setBackedUpTotal] = useState(0);
  const [storageInfo, _setStorageInfo] = useState(null);

  // Wrap setters to also cache values
  const setBackedUpTotal = (val) => {
    _setBackedUpTotal(val);
    if (val > 0) {
      try { import('../services/cache').then(c => c.setCache('photos_backed_up_total', val, 600000)); } catch {}
    }
  };
  const setStorageInfo = (val) => {
    _setStorageInfo(val);
    if (val) {
      try { import('../services/cache').then(c => c.setCache('drive_storage_info', val, 300000)); } catch {}
    }
  };

  // Load cached values on mount (instant) - photos render from cache immediately
  useEffect(() => {
    import('../services/cache').then(async (c) => {
      const cachedStorage = await c.getCached('drive_storage_info');
      if (cachedStorage) _setStorageInfo(cachedStorage);
      const cachedCount = await c.getCached('photos_backed_up_total');
      if (cachedCount) _setBackedUpTotal(cachedCount);
      // Restore cached cloud photos so grid renders instantly on navigation
      const cachedPhotos = await c.getCached('cloud_photos');
      if (cachedPhotos && cachedPhotos.length > 0 && cloudPhotos.length === 0) {
        setCloudPhotos(cachedPhotos);
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
