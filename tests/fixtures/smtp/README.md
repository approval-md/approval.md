# A self-signed certificate, for the mock SMTP server and nothing else

`test-cert.pem` / `test-key.pem` are a throwaway RSA-2048 self-signed pair for
`CN=localhost` (SAN `DNS:localhost, IP:127.0.0.1`), generated with:

```
openssl req -x509 -newkey rsa:2048 -keyout test-key.pem -out test-cert.pem \
  -sha256 -days 36500 -nodes \
  -subj "/CN=localhost/O=approval.md test fixture" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

They exist so `tests/smtp-mock.ts` can offer a real TLS handshake (implicit TLS
and the STARTTLS upgrade) on 127.0.0.1 without a network and without generating
a certificate at test time — `node:crypto` cannot mint an X.509 certificate, and
shelling out to `openssl` would make the suite depend on whatever is installed
on the machine running it.

**This key is public, committed, and worthless.** It authenticates nothing, it
is not a credential, and no production path may load it. The only thing that
accepts it is `emailAdapter({ tlsRejectUnauthorized: false })`, an option whose
default is `true` and whose sole caller is this repository's test suite
(`tests/adapter-email.test.ts` pins that default).

Regenerate whenever you like; nothing is pinned to the bytes.
