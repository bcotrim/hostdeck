#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <ServiceManagement/ServiceManagement.h>
#import <xpc/xpc.h>
#include <unistd.h>

static NSString *const ServiceName = @"dev.hostdeck.manager.helper";
static NSString *const PlistName = @"dev.hostdeck.manager.helper.plist";
extern char *hostdeck_handle_request(const char *request);
extern void hostdeck_free_response(char *response);

static char *error_response(NSString *message) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"error": message} options:0 error:nil];
    return strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
}

static NSString *signing_requirement(void) {
    SecCodeRef code = NULL;
    CFDictionaryRef information = NULL;
    SecRequirementRef requirement = NULL;
    CFStringRef text = NULL;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess) return nil;
    OSStatus result = SecCodeCopySigningInformation((SecStaticCodeRef)code, kSecCSSigningInformation, &information);
    NSDictionary *info = (__bridge NSDictionary *)information;
    BOOL valid = result == errSecSuccess
        && [info[(__bridge NSString *)kSecCodeInfoCertificates] count] > 0
        && ([info[(__bridge NSString *)kSecCodeInfoFlags] unsignedIntValue] & kSecCodeSignatureRuntime)
        && [info[(__bridge NSString *)kSecCodeInfoIdentifier] isEqual:@"dev.hostdeck.manager"];
    if (valid) result = SecCodeCheckValidity(code, kSecCSStrictValidate, NULL);
    if (valid && result == errSecSuccess) result = SecCodeCopyDesignatedRequirement((SecStaticCodeRef)code, kSecCSDefaultFlags, &requirement);
    if (valid && result == errSecSuccess) result = SecRequirementCopyString(requirement, kSecCSDefaultFlags, &text);
    NSString *value = valid && result == errSecSuccess ? [(__bridge NSString *)text copy] : nil;
    if (text) CFRelease(text);
    if (requirement) CFRelease(requirement);
    if (information) CFRelease(information);
    CFRelease(code);
    return value;
}

char *hostdeck_helper_status(void) {
    @autoreleasepool {
        if (!signing_requirement()) return strdup("unsigned");
        switch ([SMAppService daemonServiceWithPlistName:PlistName].status) {
            case SMAppServiceStatusEnabled: return strdup("enabled");
            case SMAppServiceStatusRequiresApproval: return strdup("requires_approval");
            case SMAppServiceStatusNotRegistered: return strdup("not_registered");
            default: return strdup("not_found");
        }
    }
}

char *hostdeck_enable_helper(void) {
    @autoreleasepool {
        if (!signing_requirement()) return error_response(@"Build and install a signed Hostdeck app before enabling its helper.");
        if (![[NSBundle mainBundle].bundleURL.path isEqual:@"/Applications/Hostdeck.app"])
            return error_response(@"Install Hostdeck in /Applications before enabling its helper.");
        SMAppService *service = [SMAppService daemonServiceWithPlistName:PlistName];
        NSError *error = nil;
        BOOL restart = service.status == SMAppServiceStatusEnabled;
        if (restart) {
            dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
            __block NSError *stopError = nil;
            [service unregisterWithCompletionHandler:^(NSError *failure) {
                stopError = failure;
                dispatch_semaphore_signal(stopped);
            }];
            if (dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0)
                return error_response(@"Stopping the helper timed out. Wait a moment, then enable it again.");
            if (stopError) return error_response(stopError.localizedDescription);
        }
        if (restart || service.status == SMAppServiceStatusNotRegistered || service.status == SMAppServiceStatusNotFound) {
            if (![service registerAndReturnError:&error] && service.status != SMAppServiceStatusRequiresApproval)
                return error_response(error.localizedDescription ?: @"Could not register the Hostdeck helper.");
        }
        if (service.status == SMAppServiceStatusRequiresApproval) [SMAppService openSystemSettingsLoginItems];
        return strdup("{}");
    }
}

char *hostdeck_helper_request(const char *request) {
    @autoreleasepool {
        NSString *requirement = signing_requirement();
        if (!requirement) return error_response(@"The Hostdeck helper requires a signed app. Run npm run setup-signing, then build and install Hostdeck.");
        if ([SMAppService daemonServiceWithPlistName:PlistName].status != SMAppServiceStatusEnabled)
            return error_response(@"Enable the Hostdeck helper and approve it in System Settings before applying changes.");
        xpc_connection_t connection = xpc_connection_create_mach_service(ServiceName.UTF8String, NULL, XPC_CONNECTION_MACH_SERVICE_PRIVILEGED);
        if (!connection || xpc_connection_set_peer_code_signing_requirement(connection, requirement.UTF8String) != 0)
            return error_response(@"Could not authenticate the Hostdeck helper.");
        xpc_connection_set_event_handler(connection, ^(xpc_object_t event) { (void)event; });
        xpc_connection_activate(connection);
        xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_string(message, "request", request);
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block NSString *response = nil;
        xpc_connection_send_message_with_reply(connection, message, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^(xpc_object_t reply) {
            if (xpc_get_type(reply) == XPC_TYPE_DICTIONARY && xpc_connection_get_euid(connection) == 0) {
                const char *value = xpc_dictionary_get_string(reply, "response");
                response = value ? [NSString stringWithUTF8String:value] : nil;
            } else {
                response = nil;
            }
            dispatch_semaphore_signal(ready);
        });
        BOOL timedOut = dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0;
        xpc_connection_cancel(connection);
        if (timedOut) return error_response(@"The helper timed out. Reload /etc/hosts before trying again; the operation may have completed.");
        return response ? strdup(response.UTF8String) : error_response(@"Hostdeck helper connection failed. Check its approval in System Settings; after an app update, click Re-enable helper.");
    }
}

int hostdeck_run_helper(void) {
    @autoreleasepool {
        if (geteuid() != 0) return 1;
        NSString *requirement = signing_requirement();
        if (!requirement) return 1;
        xpc_connection_t listener = xpc_connection_create_mach_service(ServiceName.UTF8String, dispatch_get_main_queue(), XPC_CONNECTION_MACH_SERVICE_LISTENER);
        if (!listener || xpc_connection_set_peer_code_signing_requirement(listener, requirement.UTF8String) != 0) return 1;
        xpc_connection_set_event_handler(listener, ^(xpc_object_t peer) {
            if (xpc_get_type(peer) != XPC_TYPE_CONNECTION) return;
            if (xpc_connection_set_peer_code_signing_requirement(peer, requirement.UTF8String) != 0) {
                xpc_connection_cancel(peer);
                return;
            }
            xpc_connection_set_event_handler(peer, ^(xpc_object_t message) {
                @autoreleasepool {
                    if (xpc_get_type(message) != XPC_TYPE_DICTIONARY) return;
                    xpc_object_t reply = xpc_dictionary_create_reply(message);
                    if (!reply) return;
                    const char *request = xpc_dictionary_get_string(message, "request");
                    char *response = request && strnlen(request, 4 * 1024 * 1024 + 1) <= 4 * 1024 * 1024
                        ? hostdeck_handle_request(request) : NULL;
                    xpc_dictionary_set_string(reply, "response", response ?: "{\"error\":\"Invalid or oversized helper request.\"}");
                    xpc_connection_send_message(xpc_dictionary_get_remote_connection(message), reply);
                    if (response) hostdeck_free_response(response);
                }
            });
            xpc_connection_activate(peer);
        });
        xpc_connection_activate(listener);
        dispatch_main();
    }
}
