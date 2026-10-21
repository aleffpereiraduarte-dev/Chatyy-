//! Mídia cifrada v1 (CONTRATO §2.4): AES-256-CTR + SHA-256 do ciphertext, formato de anexo
//! Matrix (`MediaEncryptionInfo`, "v2"). Uma chave/IV aleatórios POR ARQUIVO (cada variante
//! — tela, t320, poster — é um arquivo próprio). A info vai dentro do payload cifrado.
use crate::error::{CoreError, CoreResult};
use matrix_sdk_crypto::{AttachmentDecryptor, AttachmentEncryptor, MediaEncryptionInfo};
use std::io::{Read, Write};

fn media_err(e: impl std::fmt::Display) -> CoreError {
    CoreError::Media { msg: e.to_string() }
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct EncryptedBytes {
    pub data: Vec<u8>,
    /// JSON `MediaEncryptionInfo` (`{"v":"v2","key":{jwk},"iv":"…","hashes":{"sha256":"…"}}`).
    pub info_json: String,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct EncryptedFile {
    pub info_json: String,
    /// Tamanho do ciphertext (= tamanho do claro em CTR).
    pub size: u64,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn encrypt_bytes(plain: Vec<u8>) -> CoreResult<EncryptedBytes> {
    let mut cur = std::io::Cursor::new(&plain);
    let mut enc = AttachmentEncryptor::new(&mut cur);
    let mut data = Vec::with_capacity(plain.len());
    enc.read_to_end(&mut data).map_err(media_err)?;
    let info = enc.finish();
    Ok(EncryptedBytes { data, info_json: serde_json::to_string(&info).map_err(media_err)? })
}

fn parse_info(info_json: &str) -> CoreResult<MediaEncryptionInfo> {
    serde_json::from_str(info_json).map_err(|_| media_err("info_json inválido"))
}

/// Decifra e CONFERE o SHA-256: byte trocado → `CoreError::Media`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn decrypt_bytes(data: Vec<u8>, info_json: String) -> CoreResult<Vec<u8>> {
    let info = parse_info(&info_json)?;
    let mut cur = std::io::Cursor::new(&data);
    let mut dec = AttachmentDecryptor::new(&mut cur, info).map_err(media_err)?;
    let mut out = Vec::with_capacity(data.len());
    dec.read_to_end(&mut out).map_err(|_| media_err("hash não confere (adulterado)"))?;
    Ok(out)
}

/// Cifra em fluxo de arquivo → arquivo (não carrega tudo na memória; serve à NSE/background).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn encrypt_file(in_path: String, out_path: String) -> CoreResult<EncryptedFile> {
    let mut input = std::io::BufReader::new(std::fs::File::open(&in_path).map_err(media_err)?);
    let mut enc = AttachmentEncryptor::new(&mut input);
    let tmp = format!("{out_path}.part");
    let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(media_err)?);
    let size = std::io::copy(&mut enc, &mut out).map_err(media_err)?;
    out.flush().map_err(media_err)?;
    drop(out);
    let info = enc.finish();
    std::fs::rename(&tmp, &out_path).map_err(media_err)?;
    Ok(EncryptedFile { info_json: serde_json::to_string(&info).map_err(media_err)?, size })
}

/// Decifra arquivo → arquivo. Escreve em `<out>.part` e só renomeia se o hash conferir;
/// em erro o parcial é apagado (nunca sobra claro adulterado no cache).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn decrypt_file(in_path: String, out_path: String, info_json: String) -> CoreResult<u64> {
    let info = parse_info(&info_json)?;
    let mut input = std::io::BufReader::new(std::fs::File::open(&in_path).map_err(media_err)?);
    let mut dec = AttachmentDecryptor::new(&mut input, info).map_err(media_err)?;
    let tmp = format!("{out_path}.part");
    let res = (|| -> CoreResult<u64> {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(media_err)?);
        let n = std::io::copy(&mut dec, &mut out).map_err(|_| media_err("hash não confere (adulterado)"))?;
        out.flush().map_err(media_err)?;
        Ok(n)
    })();
    match res {
        Ok(n) => {
            std::fs::rename(&tmp, &out_path).map_err(media_err)?;
            Ok(n)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bytes_roundtrip_and_tamper() {
        let plain: Vec<u8> = (0..300_000u32).map(|i| (i * 31 % 251) as u8).collect();
        let e = encrypt_bytes(plain.clone()).unwrap();
        assert_ne!(e.data, plain);
        assert_eq!(decrypt_bytes(e.data.clone(), e.info_json.clone()).unwrap(), plain);
        let mut bad = e.data.clone();
        bad[1234] ^= 0x01;
        assert!(matches!(decrypt_bytes(bad, e.info_json.clone()), Err(CoreError::Media { .. })));
        assert!(decrypt_bytes(e.data.clone(), "{}".into()).is_err());
    }
    #[test]
    fn file_roundtrip_and_tamper() {
        let dir = tempfile::tempdir().unwrap();
        let p = |n: &str| dir.path().join(n).to_string_lossy().to_string();
        let plain = vec![42u8; 1_500_000];
        std::fs::write(p("a"), &plain).unwrap();
        let ef = encrypt_file(p("a"), p("a.enc")).unwrap();
        assert_eq!(ef.size, plain.len() as u64);
        decrypt_file(p("a.enc"), p("a.out"), ef.info_json.clone()).unwrap();
        assert_eq!(std::fs::read(p("a.out")).unwrap(), plain);
        let mut bad = std::fs::read(p("a.enc")).unwrap();
        bad[999_999] ^= 0x80;
        std::fs::write(p("b.enc"), &bad).unwrap();
        assert!(decrypt_file(p("b.enc"), p("b.out"), ef.info_json.clone()).is_err());
        assert!(!std::path::Path::new(&p("b.out")).exists());
        assert!(!std::path::Path::new(&p("b.out.part")).exists());
    }
}
