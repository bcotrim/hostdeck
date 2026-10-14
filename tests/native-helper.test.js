import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test(process.env.HOSTDECK_TEST_SIGNING_IDENTITY ? "native bridge binds trust to the app and signing key" : "native bridge rejects unsigned code", { skip: process.platform !== "darwin" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-native-test-"));
  const app = join(directory, "Hostdeck.app");
  const executable = join(app, "Contents/MacOS/hostdeck");
  const run = (program, args) => execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.hostdeck.manager</string><key>CFBundleExecutable</key><string>hostdeck</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    const source = join(directory, "test.m");
    writeFileSync(source, `#import ${JSON.stringify(resolve("src-tauri/native/helper.m"))}
char *hostdeck_handle_request(const char *request) { return NULL; }
void hostdeck_free_response(char *response) {}
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 2 && strncmp(argv[1], "--xpc-", 6) == 0) {
            BOOL deny = strcmp(argv[1], "--xpc-denied") == 0;
            NSString *requirement = signing_requirement();
            if (!requirement) return 5;
            NSString *serverRequirement = deny ? [requirement stringByAppendingString:@" and identifier \\"dev.hostdeck.other\\""] : requirement;
            xpc_connection_t listener = xpc_connection_create(NULL, NULL);
            if (xpc_connection_set_peer_code_signing_requirement(listener, serverRequirement.UTF8String) != 0) return 6;
            xpc_connection_set_event_handler(listener, ^(xpc_object_t peer) {
                if (xpc_get_type(peer) != XPC_TYPE_CONNECTION) return;
                if (xpc_connection_set_peer_code_signing_requirement(peer, serverRequirement.UTF8String) != 0) _exit(7);
                xpc_connection_set_event_handler(peer, ^(xpc_object_t message) {
                    if (xpc_get_type(message) != XPC_TYPE_DICTIONARY) return;
                    xpc_object_t reply = xpc_dictionary_create_reply(message);
                    xpc_dictionary_set_bool(reply, "ok", true);
                    xpc_connection_send_message(xpc_dictionary_get_remote_connection(message), reply);
                });
                xpc_connection_activate(peer);
            });
            xpc_connection_activate(listener);
            xpc_connection_t client = xpc_connection_create_from_endpoint(xpc_endpoint_create(listener));
            if (xpc_connection_set_peer_code_signing_requirement(client, requirement.UTF8String) != 0) return 8;
            xpc_connection_set_event_handler(client, ^(xpc_object_t event) {});
            xpc_connection_activate(client);
            dispatch_semaphore_t ready = dispatch_semaphore_create(0);
            __block BOOL accepted = NO;
            xpc_connection_send_message_with_reply(client, xpc_dictionary_create(NULL, NULL, 0), dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^(xpc_object_t reply) {
                accepted = xpc_get_type(reply) == XPC_TYPE_DICTIONARY && xpc_dictionary_get_bool(reply, "ok");
                dispatch_semaphore_signal(ready);
            });
            long timedOut = dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
            xpc_connection_cancel(client);
            xpc_connection_cancel(listener);
            return deny ? (timedOut || !accepted ? 0 : 9) : (!timedOut && accepted ? 0 : 10);
        }
        if (argc == 2) {
            NSString *text = signing_requirement();
            if (!text) return 2;
            SecRequirementRef requirement = NULL;
            SecStaticCodeRef peer = NULL;
            OSStatus result = SecRequirementCreateWithString((__bridge CFStringRef)text, kSecCSDefaultFlags, &requirement);
            NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
            if (result == errSecSuccess) result = SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &peer);
            if (result == errSecSuccess) result = SecStaticCodeCheckValidity(peer, kSecCSStrictValidate, requirement);
            if (peer) CFRelease(peer);
            if (requirement) CFRelease(requirement);
            return result == errSecSuccess ? 0 : 1;
        }
        char *status = hostdeck_helper_status();
        puts(status);
        if (strcmp(status, "unsigned") == 0) {
            char *response = hostdeck_helper_request("{\\"action\\":\\"flush\\"}");
            if (!strstr(response, "signed app")) return 3;
            free(response);
            if (hostdeck_run_helper() != 1) return 4;
        }
        free(status);
        return 0;
    }
}`);
    run("/usr/bin/clang", ["-fobjc-arc", "-fblocks", "-mmacosx-version-min=13.0", source, "-framework", "Foundation", "-framework", "Security", "-framework", "ServiceManagement", "-o", executable]);
    assert.equal(run(executable, []).trim(), "unsigned");
    if (!process.env.HOSTDECK_TEST_SIGNING_IDENTITY) return;
    const sign = (path, identifier) => run("/usr/bin/codesign", ["--force", "--sign", process.env.HOSTDECK_TEST_SIGNING_IDENTITY, "--identifier", identifier, "--options", "runtime", "--timestamp=none", path]);
    sign(app, "dev.hostdeck.manager");
    assert.notEqual(run(executable, []).trim(), "unsigned");
    assert.doesNotThrow(() => run(executable, ["--xpc-allowed"]));
    assert.doesNotThrow(() => run(executable, ["--xpc-denied"]));
    assert.doesNotThrow(() => run(executable, [app]));
    const peer = join(directory, "Peer.app");
    cpSync(app, peer, { recursive: true });
    sign(peer, "dev.hostdeck.manager");
    assert.doesNotThrow(() => run(executable, [peer]));
    sign(peer, "dev.hostdeck.other");
    assert.throws(() => run(executable, [peer]));
    run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "dev.hostdeck.manager", peer]);
    assert.throws(() => run(executable, [peer]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
