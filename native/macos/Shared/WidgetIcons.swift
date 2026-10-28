import AppKit

/// The same icons identify items in the widget and its configuration picker.
enum WidgetIcons {
    nonisolated(unsafe) static var directory = Bundle.main.resourceURL?.appendingPathComponent("characters")
    static let fallback = "vibemon-v2.png"

    static func resource(_ symbol: String?) -> String {
        switch symbol {
        case "host": "server.rack"
        case "unified": "cpu"
        case "cluster": "square.stack.3d.up"
        default: "gauge.with.dots.needle.50percent"
        }
    }

    /// Only bundled, decodable images can become picker image URLs.
    static func characterURL(_ file: String?) -> URL? {
        (load(file) ?? load(fallback))?.url
    }

    /// The decoded character art, or the fallback art. Each call decodes one file once.
    static func characterImage(_ file: String?) -> NSImage? {
        (load(file) ?? load(fallback))?.image
    }

    static func imageURL(_ file: String?) -> URL? {
        load(file)?.url
    }

    private static func load(_ file: String?) -> (url: URL, image: NSImage)? {
        guard let file, !file.contains("/"), let directory else { return nil }
        let url = directory.appendingPathComponent(file)
        return NSImage(contentsOf: url).map { (url, $0) }
    }
}
