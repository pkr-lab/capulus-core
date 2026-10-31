#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "Aufruf: $0 <push.pem | Topic> [--no-seal]" >&2
  exit 1
}

[[ $# -ge 1 ]] || usage
need openssl python3 uuidgen
if [[ -f "$1" ]]; then
  topic="$(openssl x509 -in "$1" -noout -subject -nameopt RFC2253 | sed -n 's/.*UID=\(com\.apple\.mgmt\.External\.[0-9a-fA-F-]*\).*/\1/p')"
else
  topic="$1"
fi
[[ "$topic" =~ ^com\.apple\.mgmt\.External\.[0-9a-fA-F-]+$ ]] || fail "kein gueltiges Push-Topic: $topic"

public_host="$(values_get publicHost)"
challenge="$(credential_get scep-challenge)"
org="$(sed -n 's/^  profilePrefix: //p' "$mdm_values" | head -n 1)"

umask 077
mkdir -p "$mdm_apple_dir"
out="$mdm_apple_dir/enroll.mobileconfig"
scep_uuid="$(uuidgen | tr a-z A-Z)"
mdm_uuid="$(uuidgen | tr a-z A-Z)"
profile_uuid="$(uuidgen | tr a-z A-Z)"

cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadContent</key>
			<dict>
				<key>Challenge</key>
				<string>$challenge</string>
				<key>Key Type</key>
				<string>RSA</string>
				<key>Key Usage</key>
				<integer>5</integer>
				<key>Keysize</key>
				<integer>2048</integer>
				<key>URL</key>
				<string>https://$public_host/scep</string>
			</dict>
			<key>PayloadIdentifier</key>
			<string>$org.enroll.scep</string>
			<key>PayloadType</key>
			<string>com.apple.security.scep</string>
			<key>PayloadUUID</key>
			<string>$scep_uuid</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
		<dict>
			<key>AccessRights</key>
			<integer>8191</integer>
			<key>CheckOutWhenRemoved</key>
			<true/>
			<key>IdentityCertificateUUID</key>
			<string>$scep_uuid</string>
			<key>PayloadIdentifier</key>
			<string>$org.enroll.mdm</string>
			<key>PayloadType</key>
			<string>com.apple.mdm</string>
			<key>PayloadUUID</key>
			<string>$mdm_uuid</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>ServerCapabilities</key>
			<array>
				<string>com.apple.mdm.per-user-connections</string>
				<string>com.apple.mdm.bootstraptoken</string>
				<string>com.apple.mdm.token</string>
			</array>
			<key>ServerURL</key>
			<string>https://$public_host/mdm</string>
			<key>SignMessage</key>
			<true/>
			<key>Topic</key>
			<string>$topic</string>
		</dict>
	</array>
	<key>PayloadDisplayName</key>
	<string>Capulus MDM Enrollment</string>
	<key>PayloadIdentifier</key>
	<string>$org.enroll</string>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>$profile_uuid</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
EOF

if command -v plutil >/dev/null; then
  plutil -lint "$out" >/dev/null
else
  python3 -I -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$out"
fi
echo "Enrollment-Profil: $out (Topic $topic)"

if [[ "${2:-}" == "--no-seal" ]]; then
  exit 0
fi
need kubeseal
values_edit sealed enrollmentProfile "enroll.mobileconfig=$(seal mdm-enrollment-profile "$(cat "$out")")"
echo "versiegelt in: $mdm_values (secrets.enrollmentProfile)"
echo "Mit dem naechsten Commit/Merge wird der Enrollment-Dienst unter https://$public_host/mdm/enroll ausgerollt."
