// The Node-API module that VibeMon's main process loads to refresh widgets:
//
//     require('.../widget-center.node').reloadTimelines()
//
// WidgetKit accepts reload requests only from the main executable of the app
// that contains the widgets. A helper executable in the same bundle is
// rejected, so the request must come from the Electron main process.

import WidgetKit
import CoreServices

@_cdecl("napi_register_module_v1")
public func registerModule(_ env: napi_env?, _ exports: napi_value?) -> napi_value? {
    let methods: [(String, napi_callback)] = [("reloadTimelines", reloadTimelines), ("registerApplication", registerApplication)]
    for (name, callback) in methods {
        var function: napi_value?
        guard napi_create_function(env, name, name.utf8.count, callback, nil, &function) == napi_ok,
              napi_set_named_property(env, exports, name, function) == napi_ok else { return nil }
    }
    return exports
}

/// Update only this containing App's registration; never reset the user's database.
private func registerApplication(_ env: napi_env?, _ info: napi_callback_info?) -> napi_value? {
    let status = LSRegisterURL(Bundle.main.bundleURL as CFURL, true)
    if status != noErr {
        napi_throw_error(env, nil, "Could not register the VibeMon widget host (OSStatus \(status))")
    }
    return nil
}

/// Asks WidgetKit to request new timelines from every VibeMon widget.
/// WidgetKit applies its own refresh budget. Returns `undefined`.
private func reloadTimelines(_ env: napi_env?, _ info: napi_callback_info?) -> napi_value? {
    WidgetCenter.shared.reloadAllTimelines()
    return nil
}
