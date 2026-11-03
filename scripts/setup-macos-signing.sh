#!/bin/bash
set -euo pipefail

# Keep this identity across builds: ad-hoc signatures invalidate Keychain approval.
identity='My Postico Local Development'
if [[ $(uname -s) != Darwin ]]; then
  echo 'この設定はmacOS専用です。' >&2
  exit 1
fi
keychain=$(/usr/bin/security default-keychain -d user | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')
if /usr/bin/security find-identity -v -p codesigning "$keychain" | /usr/bin/grep -Fq "\"$identity\""; then
  echo "署名証明書は設定済みです: $identity"
  exit 0
fi

umask 077
temporary=$(mktemp -d "${TMPDIR:-/tmp}/my-postico-signing.XXXXXX")
trap 'rm -rf "$temporary"' EXIT

# Reuse an existing certificate if setup was interrupted at the trust dialog.
/usr/bin/security find-certificate -c "$identity" -p "$keychain" > "$temporary/cert.pem" 2>/dev/null || true
if [[ ! -s "$temporary/cert.pem" ]]; then
  /usr/bin/openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -subj "/CN=$identity/" \
    -keyout "$temporary/key.pem" -out "$temporary/cert.pem" \
    -config <(cat <<'CONFIG'
[req]
distinguished_name = subject
x509_extensions = signing
[subject]
[signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CONFIG
)
  /usr/bin/openssl rand -base64 32 > "$temporary/password"
  /usr/bin/openssl pkcs12 -export -name "$identity" \
    -inkey "$temporary/key.pem" -in "$temporary/cert.pem" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -out "$temporary/identity.p12" -passout "file:$temporary/password"
  # Grant only codesign access; do not make the private key available to all apps.
  /usr/bin/security import "$temporary/identity.p12" -k "$keychain" \
    -P "$(cat "$temporary/password")" -x -T /usr/bin/codesign
fi

echo 'macOSの確認が表示されたら、このローカル署名証明書の設定を許可してください。'
# User trust, restricted to code signing. No TLS trust or system trust changes.
/usr/bin/security add-trusted-cert -r trustRoot -p codeSign \
  -k "$keychain" "$temporary/cert.pem"
if ! /usr/bin/security find-identity -v -p codesigning "$keychain" | /usr/bin/grep -Fq "\"$identity\""; then
  echo '有効な署名IDが見つかりません。キーチェーンアクセスで証明書と秘密鍵を確認してください。' >&2
  exit 1
fi
echo "署名証明書を設定しました: $identity"
