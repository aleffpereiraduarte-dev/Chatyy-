#cloud-config
# cloud-init runs once on first boot. We keep it minimal: Ansible does the
# heavy lifting. The only goal here is to (a) make SSH safe, (b) install
# packages Ansible needs to talk to the box, (c) drop a placeholder
# WireGuard config so the tunnel can be brought up the moment Ansible
# applies the role.

hostname: ${hostname}
preserve_hostname: false
manage_etc_hosts: true

package_update: true
package_upgrade: false   # let unattended-upgrades handle this (ansible)

packages:
  - python3
  - python3-pip
  - curl
  - wireguard
  - wireguard-tools
  - ufw
  - ca-certificates
  - gnupg
  - lsb-release

write_files:
  - path: /etc/chatyy/pop.env
    permissions: '0644'
    content: |
      CHATYY_POP_HOSTNAME=${hostname}
      CHATYY_POP_WG_IP=${wg_ip}
      CHATYY_ORIGIN_IP=${origin_ip}
      CHATYY_WG_SUBNET=${wg_subnet}
      CHATYY_ORIGIN_WG_PUBKEY=${origin_pub}
  - path: /etc/chatyy/MARK_BOOTSTRAP
    permissions: '0644'
    content: |
      cloud-init completed. Ansible expected to run next.

runcmd:
  - mkdir -p /etc/chatyy /etc/wireguard /var/log/chatyy
  - chmod 700 /etc/wireguard
  # Sysctls Ansible would set anyway, but doing them here means the WG tunnel
  # can come up the moment the role applies, shaving ~30s off pop-add.sh.
  - sysctl -w net.ipv4.ip_forward=1
  - sysctl -w net.ipv4.conf.all.rp_filter=2
  - echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-chatyy.conf
  - echo 'net.ipv4.conf.all.rp_filter=2' >> /etc/sysctl.d/99-chatyy.conf
