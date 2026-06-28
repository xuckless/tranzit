#!/usr/bin/env bash
#
# gen-mtls-certs.sh — issue the private CA + per-service X.509 certs used for
# service-to-service mutual TLS across the Tranzit backends.
#
# Each Tranzit service that talks to a sibling over the tailnet authenticates with
# a client certificate; the callee verifies it against this CA and pins the leaf's
# SAN to an allow-list. A single leaf per service carries BOTH serverAuth and
# clientAuth EKUs, so the same identity works whether the service is the caller or
# the callee (see the mTLS role matrix in AUTH.md).
#
# Output (default ./certs-out):
#   ca.crt ca.key
#   <svc>.crt <svc>.key            for each service below
#
# Distribute into each repo's git-ignored certs/ dir:
#   cp certs-out/ca.crt                 <repo>/certs/ca.crt
#   cp certs-out/<svc>.crt <svc>.key    <repo>/certs/      # only that repo's own leaf
#
# Re-run to rotate: regenerate, redistribute, redeploy. The CA is long-lived
# (10y); leaves are 2y. Keep ca.key OFFLINE/secret — anyone holding it can mint a
# trusted service identity.
#
# Requires: openssl 1.1.1+ (EC P-256 keys, -addext / x509 -extfile).
set -euo pipefail

OUT="${1:-certs-out}"
CA_DAYS="${CA_DAYS:-3650}"
LEAF_DAYS="${LEAF_DAYS:-730}"

# The service identities. The name is the cert CN *and* DNS SAN; clients set
# tls.Config.ServerName to it (decoupling the cert from the tailnet IP), and
# servers match it against MTLS_ALLOWED_CLIENTS.
SERVICES=(
  tranzit-db-middleware
  tranzit-route-service
  tranzit-route-save
)

mkdir -p "$OUT"
cd "$OUT"

echo "==> generating CA"
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days "$CA_DAYS" -out ca.crt \
  -subj "/CN=Tranzit Service CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

for svc in "${SERVICES[@]}"; do
  echo "==> issuing leaf: $svc"
  openssl ecparam -name prime256v1 -genkey -noout -out "$svc.key"
  openssl req -new -key "$svc.key" -out "$svc.csr" -subj "/CN=$svc"
  openssl x509 -req -in "$svc.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -sha256 -days "$LEAF_DAYS" -out "$svc.crt" \
    -extfile <(cat <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:$svc
EOF
)
  rm -f "$svc.csr"
done

rm -f ca.srl
chmod 600 ./*.key

echo
echo "Done. Files in $(pwd):"
ls -1
echo
echo "Distribute (per repo, only its OWN leaf + the shared ca.crt):"
for svc in "${SERVICES[@]}"; do
  echo "  $svc:  ca.crt + $svc.crt + $svc.key"
done
