#!/bin/sh
# Entry point for the Cloud Run image: bring up Tailscale in userspace mode, join the
# tailnet, then start the Go server. The OTP client routes through the Tailscale outbound
# proxy (OTP_HTTP_PROXY); Google Places calls go direct.
set -e

: "${TS_HOSTNAME:=tranzit-route-service}"
: "${OTP_HTTP_PROXY:=http://localhost:1055}"
export OTP_HTTP_PROXY

if [ -z "${TS_AUTHKEY}" ]; then
  echo "WARNING: TS_AUTHKEY not set — OTP (tailnet) calls will fail. Starting server anyway." >&2
  exec /app/server
fi

# Userspace networking (Cloud Run has no TUN device). One port serves both SOCKS5 and HTTP proxy.
/usr/local/bin/tailscaled \
  --state=mem: \
  --tun=userspace-networking \
  --socks5-server=localhost:1055 \
  --outbound-http-proxy-listen=localhost:1055 &

# Join the tailnet (use a reusable + ephemeral key so autoscaled instances self-clean).
until /usr/local/bin/tailscale up \
  --authkey="${TS_AUTHKEY}" \
  --hostname="${TS_HOSTNAME}" \
  --accept-dns=false; do
  echo "tailscale up failed; retrying in 1s..." >&2
  sleep 1
done
echo "Tailscale connected as ${TS_HOSTNAME}; OTP_BASE_URL=${OTP_BASE_URL} via ${OTP_HTTP_PROXY}"

exec /app/server
