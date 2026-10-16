import Foundation

/// The result of reading the widget feed.
enum FeedLoad: Sendable {
    /// The App has not written a feed yet, or the file was removed.
    case missing
    /// The feed comes from a newer or older App with another format.
    case unsupported
    /// The file exists but cannot be read or decoded.
    case unreadable
    case loaded(WidgetFeed)

    var feed: WidgetFeed? {
        if case .loaded(let feed) = self { return feed }
        return nil
    }
}

/// Reads `~/.vibemon/widgets/feed.json`.
///
/// The widget extension runs in the App Sandbox, where `HOME` points to its
/// container. The sandbox entitlement grants read-only access to this one
/// folder of the real home directory, so the path starts at the account's
/// home from the user database.
enum FeedStore {
    static let relativePath = ".vibemon/widgets/feed.json"

    static var url: URL {
        URL(fileURLWithPath: accountHome, isDirectory: true).appendingPathComponent(relativePath)
    }

    static func load(from url: URL = url) -> FeedLoad {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch CocoaError.fileReadNoSuchFile {
            return .missing
        } catch {
            return .unreadable
        }
        guard let header = try? JSONDecoder().decode(Header.self, from: data) else { return .unreadable }
        guard header.version == WidgetFeed.supportedVersion else { return .unsupported }
        guard let feed = try? WidgetFeed.decode(data) else { return .unreadable }
        return .loaded(feed)
    }

    private struct Header: Decodable {
        let version: Int
    }

    private static var accountHome: String {
        if let entry = getpwuid(getuid()), let directory = entry.pointee.pw_dir {
            return String(cString: directory)
        }
        return NSHomeDirectory()
    }
}
