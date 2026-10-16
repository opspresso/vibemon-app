import Foundation

/// The presentation model that VibeMon writes for its widgets.
///
/// The App computes every state, label, tone, and formatted value
/// (`src/widgets/feed.mjs`). The widget only selects the entry for the
/// current time and lays it out.
struct WidgetFeed: Decodable, Sendable {
    /// The feed format that this widget build reads.
    static let supportedVersion = 1

    let version: Int
    let generatedAt: Date
    /// `false` after the App quits. The values are then the last known ones.
    let running: Bool
    let items: [FeedItem]

    func items(of kind: FeedItem.Kind) -> [FeedItem] {
        items.filter { $0.kind == kind }
    }

    func item(id: String) -> FeedItem? {
        items.first { $0.id == id }
    }
}

struct FeedItem: Decodable, Sendable, Identifiable {
    enum Kind: String, Decodable, Sendable {
        case resource
        case agent
    }

    let id: String
    let kind: Kind
    let title: String
    let subtitle: String
    /// Resource icon: `host`, `unified`, `cluster`, or `resource`.
    let symbol: String?
    /// Agent character art file in the bundled `characters` folder.
    let artwork: String?
    let observedAt: Date
    let message: String?
    let metrics: [FeedMetric]
    /// Display states in time order. The first entry starts at feed time.
    let timeline: [FeedStatus]
    /// The Dashboard page that shows this item.
    let link: URL

    /// The display state at `date`: the last entry that started at or before it.
    func status(at date: Date) -> FeedStatus {
        timeline.last { $0.at <= date } ?? timeline[0]
    }

    /// Start times of later display states, for timeline entries.
    func changes(after date: Date) -> [Date] {
        timeline.map(\.at).filter { $0 > date }
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, title, subtitle, symbol, artwork, observedAt, message, metrics, timeline, link
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(Kind.self, forKey: .kind)
        title = try container.decode(String.self, forKey: .title)
        subtitle = try container.decode(String.self, forKey: .subtitle)
        symbol = try container.decodeIfPresent(String.self, forKey: .symbol)
        artwork = try container.decodeIfPresent(String.self, forKey: .artwork)
        observedAt = try container.decode(Date.self, forKey: .observedAt)
        message = try container.decodeIfPresent(String.self, forKey: .message)
        metrics = try container.decode([FeedMetric].self, forKey: .metrics)
        timeline = try container.decode([FeedStatus].self, forKey: .timeline)
        link = try container.decode(URL.self, forKey: .link)
        guard !timeline.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .timeline, in: container, debugDescription: "An item needs at least one status")
        }
    }
}

struct FeedStatus: Decodable, Sendable, Equatable {
    let at: Date
    let state: String
    let label: String
    let tone: Tone
}

struct FeedMetric: Decodable, Sendable, Identifiable {
    let key: String
    let label: String
    /// Formatted number without its unit, or `—` when not reported.
    let value: String
    let unit: String
    /// Gauge fill from 0 to 1. `nil` for numbers and missing values.
    let fraction: Double?
    let tone: MetricTone

    var id: String { key }
}

/// The meaning of a state. Each tone has one palette color.
enum Tone: String, Decodable, Sendable {
    case good, warning, danger, neutral, active

    init(from decoder: Decoder) throws {
        // A newer App can add tones. Show them as neutral, not as an error.
        self = Tone(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .neutral
    }
}

enum MetricTone: String, Decodable, Sendable {
    case normal, warning, danger

    init(from decoder: Decoder) throws {
        self = MetricTone(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .normal
    }
}

extension WidgetFeed {
    /// Decodes a feed. JavaScript writes ISO 8601 times with milliseconds.
    static func decode(_ data: Data) throws -> WidgetFeed {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) { return date }
            if let date = try? Date.ISO8601FormatStyle().parse(text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid date: \(text)"))
        }
        return try decoder.decode(WidgetFeed.self, from: data)
    }
}
