#!/bin/sh
# Roda NO EDGE (como root): instala release + config. Uso:
#   install.sh <dir_com_release_tgz_e_tls> <wg_ip> <regiao> <regioes> <irmas>
set -eu
SRC=$1 IP=$2 REG=$3 REGS=$4 SIS=$5
id chatyy-router >/dev/null 2>&1 || useradd --system --home-dir /var/lib/chatyy-router --shell /usr/sbin/nologin chatyy-router
install -d -m 0750 -o chatyy-router -g chatyy-router /var/lib/chatyy-router /var/lib/chatyy-router/mnesia
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
[ -f /etc/chatyy-router/flags ] || printf 'RT_ROUTE=1\n' > /etc/chatyy-router/flags
chmod 0644 /etc/chatyy-router/flags
cat > /etc/chatyy-router/env <<EOT
ROUTER_WG_IP=$IP
ROUTER_DIST_PORT=4370
ROUTER_REGION=$REG
ROUTER_REGIONS=$REGS
ROUTER_SISTERS=$SIS
ROUTER_STORE=disc
ROUTER_FAILOVER_MS=60000
ROUTER_CTL_PORT=4790
ROUTER_FLAGS_FILE=/etc/chatyy-router/flags
ROUTER_SCHEDULERS=2
EOT
chown root:chatyy-router /etc/chatyy-router/env && chmod 0640 /etc/chatyy-router/env
install -m 0644 "$SRC/chatyy-router.service" /etc/systemd/system/chatyy-router.service
systemctl daemon-reload
rm -rf "$SRC"
echo "instalado em $(hostname)"
