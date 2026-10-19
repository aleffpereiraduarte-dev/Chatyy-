// [2026-10-19 sticker-cache] Configurações › Armazenamento: "Limpar cache de
// figurinhas e GIFs" com o tamanho no disco (services/stickerCache, conta ativa).
// Recentes e favoritas ficam (são escolhas do usuário); as imagens voltam a
// baixar quando aparecerem. Só nativo (no web o navegador guarda).
import { useState, useCallback, useRef, useEffect } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useLanguage } from '../../context/LanguageContext';
import { useConfirm } from '../ConfirmModal';
import { SettingsGroup, SettingsRow } from './SettingsKit';

function _tr(t, key, fb) {
  try { const v = t ? t(key) : ''; return v && v !== key ? v : fb; } catch { return fb; }
}
function fmtBytes(b) {
  const bytes = Math.max(0, Number(b) || 0);
  if (bytes < 1024) return bytes === 0 ? '0 KB' : '< 1 KB';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} GB`;
}
function _sizeNow() {
  try { return require('../../services/stickerCache').getStickerCacheSizeSync(); } catch { return 0; }
}

export default function StickerGifCacheGroup() {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [bytes, setBytes] = useState(_sizeNow);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useFocusEffect(useCallback(() => { setBytes(_sizeNow()); return undefined; }, []));
  useEffect(() => {
    let un = () => {};
    try { un = require('../../services/stickerCache').subscribeStickerCache(() => { if (alive.current) setBytes(_sizeNow()); }); } catch {}
    return un;
  }, []);

  const title = _tr(t, 'settings.storage.clearStickerCache', 'Limpar cache de figurinhas e GIFs');
  const onClear = async () => {
    const ok = await confirm({
      title: _tr(t, 'settings.storage.clearStickerCacheConfirmTitle', 'Limpar figurinhas e GIFs salvos?'),
      message: _tr(t, 'settings.storage.clearStickerCacheConfirm', 'As figurinhas e os GIFs salvos neste aparelho serão apagados e baixados de novo quando aparecerem. Suas favoritas e recentes continuam.'),
      confirmLabel: _tr(t, 'settings.storage.clearStickerCacheAction', 'Limpar'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try { await require('../../services/stickerCache').clearStickerCache(); } catch {}
    if (!alive.current) return;
    setBytes(_sizeNow());
    setBusy(false);
  };

  if (Platform.OS === 'web') return null;
  return (
    <SettingsGroup
      header={_tr(t, 'settings.storage.stickersGifs', 'Figurinhas e GIFs')}
      footer={_tr(t, 'settings.storage.stickersGifsFooter', 'Figurinhas, pacotes instalados e GIFs recentes ficam salvos no aparelho para abrir na hora, até sem internet (até 300 MB; os menos usados saem primeiro).')}
    >
      <SettingsRow
        title={busy ? '…' : title}
        value={fmtBytes(bytes)}
        destructive
        disabled={busy}
        chevron={false}
        onPress={busy ? undefined : onClear}
        accessibilityLabel={`${title}, ${fmtBytes(bytes)}`}
        testID="storage-clear-sticker-cache"
      />
    </SettingsGroup>
  );
}
