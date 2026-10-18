import Foundation

/// Full IDs remain stable while the picker uses short, searchable labels.
enum WidgetCatalog {
    struct Entry {
        let id: String
        let title: String
        let subtitle: String
        let symbol: String?
        let artwork: String?
    }

    static func items(_ kind: FeedItem.Kind, from load: FeedLoad = FeedStore.load(), matching query: String? = nil) -> [Entry] {
        (load.feed?.items(of: kind) ?? []).map { item in
            Entry(
                id: item.id,
                title: item.selectionTitle ?? (kind == .agent ? "\(item.title) · \(item.subtitle)" : item.title),
                subtitle: item.selectionSubtitle ?? item.subtitle,
                symbol: item.symbol,
                artwork: item.artwork
            )
        }.filter { entry in
            let search = query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return search.isEmpty || [entry.title, entry.subtitle, entry.id].contains { $0.localizedStandardContains(search) }
        }
    }

    /// Retain a removed choice; never silently switch an installed widget.
    static func resolve(_ identifiers: [String], kind: FeedItem.Kind, from load: FeedLoad = FeedStore.load()) -> [Entry] {
        let known = Dictionary(items(kind, from: load).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return identifiers.map { known[$0] ?? Entry(id: $0, title: Localization.text("Unavailable"), subtitle: Localization.text("Choose another item"), symbol: nil, artwork: nil) }
    }
}
