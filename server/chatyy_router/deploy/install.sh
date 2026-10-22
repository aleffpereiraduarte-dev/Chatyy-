#!/bin/sh
# Roda NO EDGE (como root): instala release + config. Uso:
#   install.sh <dir_com_release_tgz_tls_env>
# (o env completo vem pronto do subir.sh; aqui só instala)
set -eu
SRC=$1
id chatyy-router >/dev/null 2>&1 || useradd --system --home-dir /var/lib/chatyy-router --shell /usr/sbin/nologin chatyy-router
install -d -m 0750 -o chatyy-router -g chatyy-router /var/lib/chatyy-router /var/lib/chatyy-router/mnesia /var/lib/chatyy-router/log
install -d -m 0750 -o root -g chatyy-router /etc/chatyy-router /etc/chatyy-router/tls
rm -rf /opt/chatyy-router.new && mkdir -p /opt/chatyy-router.new
tar -xzf "$SRC/release.tgz" -C /opt/chatyy-router.new
install -m 0755 "$SRC/rt-start" /opt/chatyy-router.new/bin/rt-start
rm -rf /opt/chatyy-router.old; [ -d /opt/chatyy-router ] && mv /opt/chatyy-router /opt/chatyy-router.old
mv /opt/chatyy-router.new /opt/chatyy-router && chown -R root:root /opt/chatyy-router && rm -rf /opt/chatyy-router.old
install -m 0640 -o root -g chatyy-router "$SRC/ssl_dist.conf" /etc/chatyy-router/ssl_dist.conf
install -m 0644 -o root -g chatyy-router "$SRC/tls/ca.pem" /etc/chatyy-router/tls/ca.pem
install -m 0644 -o root -g chatyy-router "$SRC/tls/node.pem" /etc/chatyy-router/tls/node.pem
install -m 0640 -o root -g chatyy-router "$SRC/tls/node.key" /etc/chatyy-router/tls/node.key
install -m 0400 -o chatyy-router -g chatyy-router "$SRC/cookie" /var/lib/chatyy-router/.erlang.cookie
[ -f /etc/chatyy-router/flags ] || printf 'RT_ROUTE=1\nRT_FANOUT=0\n' > /etc/chatyy-router/flags
chmod 0644 /etc/chatyy-router/flags
install -m 0640 -o root -g chatyy-router "$SRC/env" /etc/chatyy-router/env
# papéis PG de menor privilégio (réplica local: SELECT; master: só EXECUTE da CAS) — /root/roteador-2026-10-22/r1/PG.md
for f in pg-ro.pass pg-cas.pass; do [ -f "$SRC/$f" ] && install -m 0640 -o root -g chatyy-router "$SRC/$f" /etc/chatyy-router/$f; done
chown root:chatyy-router /etc/chatyy-router/env && chmod 0640 /etc/chatyy-router/env
install -m 0644 "$SRC/chatyy-router.service" /etc/systemd/system/chatyy-router.service
systemctl daemon-reload
rm -rf "$SRC"
echo "instalado em $(hostname)"
