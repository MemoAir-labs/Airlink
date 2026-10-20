#!/bin/sh
# Runs as root only long enough to fence the network, then becomes the runner user with no
# capabilities. Jails share this container's network, so these rules are what keep agents' code on
# the internet and off everything local: other containers, the host, link-local metadata, and the
# control server itself (a jail could otherwise post to it over loopback). Fails closed: any rule
# that does not apply stops the container.
set -eu

port="${RUNNER_CONTROL_PORT:-7000}"

iptables -A INPUT -i lo -p tcp --dport "$port" -m conntrack --ctstate NEW -j DROP
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -p tcp --dport "$port" -j DROP
# Loopback carries Docker's resolver at 127.0.0.11, which Docker DNATs to a random port.
iptables -A OUTPUT -o lo -j ACCEPT
for host in $(getent ahostsv4 host.docker.internal | awk '{print $1}' | sort -u) \
  $(ip -4 route show default | awk '{print $3}'); do
  iptables -A OUTPUT -d "$host" -j DROP
done
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
  192.168.0.0/16 198.18.0.0/15 224.0.0.0/3; do
  iptables -A OUTPUT -d "$net" -j DROP
done

ip6tables -A INPUT -i lo -p tcp --dport "$port" -m conntrack --ctstate NEW -j DROP
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -o lo -p tcp --dport "$port" -j DROP
ip6tables -A OUTPUT -o lo -j ACCEPT
for host in $(getent ahostsv6 host.docker.internal | awk '{print $1}' | grep -v '^::ffff:' | sort -u) \
  $(ip -6 route show default | awk '{print $3}'); do
  ip6tables -A OUTPUT -d "$host" -j DROP
done
for net in ::1/128 fc00::/7 fe80::/10 ff00::/8; do
  ip6tables -A OUTPUT -d "$net" -j DROP
done

exec setpriv --reuid=10001 --regid=10001 --init-groups --inh-caps=-all --bounding-set=-all \
  --no-new-privs -- node /opt/runner/control.mjs
