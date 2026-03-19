import React, { createContext, useContext, useState, useRef } from 'react';

const PhotosContext = createContext(null);

export function PhotosProvider({ children }) {
  // Persisted state - survives navigation
  const [devicePhotos, setDevicePhotos] = useState([]);
  const [cloudPhotos, setCloudPhotos] = useState([]);
  const [deviceTotalCount, setDeviceTotalCount] = useState(0);
  const [backedUpTotal, setBackedUpTotal] = useState(0);
  const [storageInfo, setStorageInfo] = useState(null);
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
