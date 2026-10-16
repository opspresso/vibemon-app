import Foundation

/// The moments at which a widget's rendering changes.
///
/// WidgetKit renders entries at their dates without running code in between.
/// The plan adds an entry for each later display state in the feed and for
/// each change of the report age text, up to `horizon`. After the horizon,
/// WidgetKit asks for a new timeline and the widget reads the feed again.
enum TimelinePlan {
    static let horizon: TimeInterval = 60 * 60

    static func dates(for content: WidgetContent, now: Date) -> [Date] {
        guard case .item(let item, _) = content else { return [now] }
        let end = now.addingTimeInterval(horizon)
        let changes = item.changes(after: now) + ageChanges(since: item.observedAt, after: now, until: end)
        return [now] + Set(changes.filter { $0 <= end }).sorted()
    }

    /// The times at which `Age.text` shows a new value.
    static func ageChanges(since observed: Date, after now: Date, until end: Date) -> [Date] {
        var dates: [Date] = []
        var elapsed = max(0, now.timeIntervalSince(observed))
        while true {
            let step: TimeInterval = elapsed < 3600 ? 60 : elapsed < 86400 ? 3600 : 86400
            elapsed = (elapsed / step).rounded(.down) * step + step
            let date = observed.addingTimeInterval(elapsed)
            if date > end { return dates }
            dates.append(date)
        }
    }
}
