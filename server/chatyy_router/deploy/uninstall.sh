#!/bin/sh
# Remove TUDO do roteador deste host (dados da fila inclusive).
set -u
systemctl disable --now chatyy-router.service 2>/dev/null
rm -f /etc/systemd/system/chatyy-router.service
systemctl daemon-reload
rm -rf /opt/chatyy-router /opt/chatyy-router.old /opt/chatyy-router.new /etc/chatyy-router /var/lib/chatyy-router
userdel chatyy-router 2>/dev/null
echo "removido de $(hostname)"
