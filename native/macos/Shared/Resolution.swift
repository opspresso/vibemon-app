extension WidgetContent {
    /// Chooses what a widget of `kind` shows for its saved choice.
    ///
    /// - A widget without a choice shows the first item of its kind.
    /// - A saved choice that left the feed shows an unavailable notice; the
    ///   widget never switches to another item by itself.
    static func resolve(_ load: FeedLoad, kind: FeedItem.Kind, selection: String?) -> WidgetContent {
        let feed: WidgetFeed
        switch load {
        case .missing: return .notice(.appMissing)
        case .unsupported: return .notice(.appUnsupported)
        case .unreadable: return .notice(.feedUnreadable)
        case .loaded(let loaded): feed = loaded
        }
        if let selection {
            guard let item = feed.item(id: selection), item.kind == kind else { return .notice(.unavailable(kind)) }
            return .item(item)
        }
        guard let item = feed.items(of: kind).first else { return .notice(.empty(kind)) }
        return .item(item)
    }
}
