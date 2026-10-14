import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const identity = "Hostdeck Local Development";
const run = (program, args) => execFileSync(program, args, { encoding: "utf8" });
const identities = () => run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
if (process.platform !== "darwin") throw new Error("Hostdeck signing requires macOS.");
if (identities().includes(`"${identity}"`)) {
  console.log(`${identity} is ready.`);
} else {
  process.umask(0o077);
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-signing-"));
  const keychain = run("/usr/bin/security", ["default-keychain", "-d", "user"]).trim().replaceAll('"', "");
  const key = join(directory, "signing.key");
  const certificate = join(directory, "signing.crt");
  const archive = join(directory, "signing.p12");
  const config = join(directory, "openssl.cnf");
  try {
    writeFileSync(config, `[req]
prompt = no
distinguished_name = name
x509_extensions = signing
[name]
CN = ${identity}
[signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`);
    run("/usr/bin/openssl", ["req", "-new", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650", "-config", config, "-keyout", key, "-out", certificate]);
    run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", certificate, "-out", archive, "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1", "-passout", "pass:hostdeck-temporary-import"]);
    run("/usr/bin/security", ["import", archive, "-k", keychain, "-x", "-P", "hostdeck-temporary-import", "-T", "/usr/bin/codesign"]);
    run("/usr/bin/security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, certificate]);
    if (!identities().includes(`"${identity}"`)) throw new Error("The signing identity was not accepted by macOS.");
    console.log(`${identity} is ready in your login Keychain.`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
