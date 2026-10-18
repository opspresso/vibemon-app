import AppKit

/// The same icons identify items in the widget and its configuration picker.
enum WidgetIcons {
    nonisolated(unsafe) static var directory = Bundle.main.resourceURL?.appendingPathComponent("characters")
    static let fallback = "vibemon-v2.png"

    static func resource(_ symbol: String?) -> String {
        switch symbol {
        case "host": "desktopcomputer"
        case "unified": "memorychip"
        case "cluster": "square.stack.3d.up"
        default: "cylinder.split.1x2"
        }
    }

    /// Only bundled, decodable images can become picker image URLs.
    static func characterURL(_ file: String?) -> URL? {
        imageURL(file) ?? imageURL(fallback)
    }

    static func imageURL(_ file: String?) -> URL? {
        guard let file, !file.contains("/"), let directory else { return nil }
        let url = directory.appendingPathComponent(file)
        return NSImage(contentsOf: url) == nil ? nil : url
    }
}
