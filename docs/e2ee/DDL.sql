-- E2EE v5 do Chatyy — PROPOSTA de esquema (contrato e2ee5-contrato/1.0, §4 e §8).
-- SÓ ADITIVO. Dono da aplicação: WP-05 (tabelas e2ee5_*) e WP-07 (colunas em chat_*).
-- Cópia em /root/e2ee-2026-10-21/ddl/000-schema.sql. NÃO aplicado.
-- Ids de usuário no fio: '@u<uid>:chatyy'; aqui guardamos o uid (bigint).

BEGIN;

-- §1.1 uid estável por conta (e-mail canônico: lower/trim, @onemundo.com.br -> @chatyy.com.br)
CREATE TABLE IF NOT EXISTS e2ee5_uid (
  uid          bigserial PRIMARY KEY,
  email_canon  text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- §9 allowlist (QA). NUNCA inserir duarte@.
CREATE TABLE IF NOT EXISTS e2ee5_allow (
  email_canon  text PRIMARY KEY,
  enabled      boolean NOT NULL DEFAULT true,
  flags        text[] NOT NULL DEFAULT '{}',      -- e2ee5_media, e2ee5_calls, ... por conta
  added_at     timestamptz NOT NULL DEFAULT now()
);

-- §4.2.2/4.2.3 aparelhos (device_keys = JSON Matrix com assinaturas acumuladas)
CREATE TABLE IF NOT EXISTS e2ee5_devices (
  uid          bigint NOT NULL REFERENCES e2ee5_uid(uid),
  device_id    text   NOT NULL CHECK (device_id ~ '^[PWTX][A-Z2-7]{12}$'),
  kind         char(1) NOT NULL,                  -- P W T X
  ed25519      text   NOT NULL,
  curve25519   text   NOT NULL,
  device_keys  jsonb  NOT NULL,
  label        text,
  platform     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  PRIMARY KEY (uid, device_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS e2ee5_devices_devid ON e2ee5_devices (device_id);

CREATE TABLE IF NOT EXISTS e2ee5_otks (
  uid        bigint NOT NULL,
  device_id  text   NOT NULL,
  key_id     text   NOT NULL,                     -- 'signed_curve25519:AAAAAQ'
  key_json   jsonb  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, device_id, key_id)
);

CREATE TABLE IF NOT EXISTS e2ee5_fallback (
  uid        bigint NOT NULL,
  device_id  text   NOT NULL,
  key_id     text   NOT NULL,
  key_json   jsonb  NOT NULL,
  used       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (uid, device_id)
);

-- §4.5 anti-dreno: contagem por (requisitante, aparelho alvo, hora)
CREATE TABLE IF NOT EXISTS e2ee5_claim_log (
  requester_uid bigint NOT NULL,
  target_uid    bigint NOT NULL,
  target_device text   NOT NULL,
  hour          timestamptz NOT NULL,             -- date_trunc('hour', now())
  n             int    NOT NULL DEFAULT 0,
  PRIMARY KEY (requester_uid, target_uid, target_device, hour)
);

-- §4.2.5 chaves de conta (MSK/SSK/USK)
CREATE TABLE IF NOT EXISTS e2ee5_xsign (
  uid           bigint PRIMARY KEY REFERENCES e2ee5_uid(uid),
  master_key    jsonb NOT NULL,
  self_signing  jsonb NOT NULL,
  user_signing  jsonb NOT NULL,
  msk_pub       text  NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  generation    int   NOT NULL DEFAULT 1          -- +1 a cada reset de identidade
);

-- §4.2.8 fluxo de mudanças de aparelho (cursor = id)
CREATE TABLE IF NOT EXISTS e2ee5_device_changes (
  id          bigserial PRIMARY KEY,
  uid         bigint NOT NULL,                    -- de quem mudou
  kind        text   NOT NULL,                    -- device_new, device_del, signature, msk_reset, member
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS e2ee5_device_changes_uid ON e2ee5_device_changes (uid, id);

-- §4.2.7 fila to-device por aparelho (apaga no ack do sync; TTL 30 dias)
CREATE TABLE IF NOT EXISTS e2ee5_to_device (
  id             bigserial PRIMARY KEY,
  target_uid     bigint NOT NULL,
  target_device  text   NOT NULL,
  sender_uid     bigint NOT NULL,                 -- carimbado pelo servidor
  sender_device  text   NOT NULL,
  event_type     text   NOT NULL,
  content        jsonb  NOT NULL,                 -- opaco (Olm)
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS e2ee5_to_device_target ON e2ee5_to_device (target_uid, target_device, id);

CREATE TABLE IF NOT EXISTS e2ee5_txn (
  uid        bigint NOT NULL,
  device_id  text   NOT NULL,
  txn_id     text   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, device_id, txn_id)
);

-- §4.2.11–4.2.17 backup e secret storage (tudo opaco para o servidor)
CREATE TABLE IF NOT EXISTS e2ee5_backup_versions (
  uid         bigint NOT NULL,
  version     bigserial,
  algorithm   text   NOT NULL,
  auth_data   jsonb  NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, version)
);
CREATE TABLE IF NOT EXISTS e2ee5_backup_keys (
  uid                  bigint NOT NULL,
  version              bigint NOT NULL,
  room_id              text   NOT NULL,           -- '!c<conv>:chatyy'
  session_id           text   NOT NULL,
  first_message_index  int    NOT NULL,
  forwarded_count      int    NOT NULL,
  is_verified          boolean NOT NULL,
  session_data         jsonb  NOT NULL,
  PRIMARY KEY (uid, version, room_id, session_id)
);
CREATE TABLE IF NOT EXISTS e2ee5_secret_storage (
  uid         bigint PRIMARY KEY,
  key_id      text  NOT NULL,
  key_info    jsonb NOT NULL,
  argon2      jsonb,
  secrets     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- §4.2.18 rendezvous do vínculo (TTL 2 min / máx 10 min)
CREATE TABLE IF NOT EXISTS e2ee5_link (
  link_id     text PRIMARY KEY,
  owner_uid   bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  finished    boolean NOT NULL DEFAULT false,
  created_ip  inet
);
CREATE TABLE IF NOT EXISTS e2ee5_link_msgs (
  link_id  text   NOT NULL REFERENCES e2ee5_link(link_id) ON DELETE CASCADE,
  side     char(1) NOT NULL CHECK (side IN ('p','w')),
  seq      int    NOT NULL,
  data     text   NOT NULL,
  PRIMARY KEY (link_id, side, seq)
);

-- §4.2.20 métricas agregadas (sem ids de mensagem)
CREATE TABLE IF NOT EXISTS e2ee5_metrics (
  day          date NOT NULL,
  platform     text NOT NULL,
  app_version  text NOT NULL,
  counters     jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (day, platform, app_version)
);

-- §4.1 bearer vinculado ao aparelho (F4) — coluna aditiva na tabela atual
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS e2ee5_device text;

-- §8.1 estado da conversa (WP-07)
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS e2ee_mode smallint NOT NULL DEFAULT 0;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS e2ee_since_pts bigint;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS e2ee_changed_at timestamptz;

-- §2.5 metadados em claro (WP-07)
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS has_link boolean;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS mention_all boolean;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edit_of bigint;
-- §2.7 reação cifrada (F2)
ALTER TABLE chat_message_reactions ADD COLUMN IF NOT EXISTS enc text;

COMMIT;
