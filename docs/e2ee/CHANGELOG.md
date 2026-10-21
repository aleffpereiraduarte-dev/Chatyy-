# Contrato E2EE v5 — histórico

## e2ee5-contrato/1.0 — 21/10/2026 (WP-00)
- Primeira versão. Fixa: ids (§1), envelope `e2e:5` + payload v1 por tipo (§2), eventos
  `chatyy.*` (§3), 20 ações `e2ee5_*` com autorização, rate limits e códigos (§4), eventos WS
  `e2ee5_td`/`e2ee5_devices`/`conv_e2ee` (§5), API do núcleo (§6), push (§7), estados de
  conversa (§8), flags (§9), i18n (§10), conformidade (§11).
- Decisões do founder (21/10) incorporadas: D1 matrix-sdk-crypto; D2 IA/tradução só explícitas;
  D3 servidor não lê privadas; D4 web só por QR (exceção conta sem celular + backup obrigatório);
  D5 histórico completo (opção 3 meses); D6 Kids fora; D7 jogos/cartões fora; D8 versão mínima
  + revisão externa na F7.
- Diferença em relação ao WORK_PACKAGES: `to_device_pull`/`ack`/`device_changes` viraram uma
  ação só, `e2ee5_sync` (cursor = ack). As duas antigas ficam como aliases de depuração.
  Ações novas: `e2ee5_device_delete`, `e2ee5_devices_list`, `e2ee5_backup_version_delete`.
