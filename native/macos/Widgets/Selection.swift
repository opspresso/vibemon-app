import AppIntents
import WidgetKit

// Each widget shows one item. Its configuration stores the item's feed ID;
// the queries list the items that the App currently writes to the feed.

struct ResourceEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Resource"
    static let defaultQuery = ResourceQuery()

    let id: String
    let title: String
    let subtitle: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)")
    }
}

struct AgentEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Coding Agent"
    static let defaultQuery = AgentQuery()

    let id: String
    let title: String
    let subtitle: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)")
    }
}

struct ResourceQuery: EntityQuery {
    func entities(for identifiers: [ResourceEntity.ID]) async throws -> [ResourceEntity] {
        Catalog.resolve(identifiers, kind: .resource).map { ResourceEntity(id: $0.id, title: $0.title, subtitle: $0.subtitle) }
    }

    func suggestedEntities() async throws -> [ResourceEntity] {
        Catalog.items(.resource).map { ResourceEntity(id: $0.id, title: $0.title, subtitle: $0.subtitle) }
    }

    func defaultResult() async -> ResourceEntity? {
        try? await suggestedEntities().first
    }
}

struct AgentQuery: EntityQuery {
    func entities(for identifiers: [AgentEntity.ID]) async throws -> [AgentEntity] {
        Catalog.resolve(identifiers, kind: .agent).map { AgentEntity(id: $0.id, title: $0.title, subtitle: $0.subtitle) }
    }

    func suggestedEntities() async throws -> [AgentEntity] {
        Catalog.items(.agent).map { AgentEntity(id: $0.id, title: $0.title, subtitle: $0.subtitle) }
    }

    func defaultResult() async -> AgentEntity? {
        try? await suggestedEntities().first
    }
}

/// Feed items in the form that the configuration picker lists.
private enum Catalog {
    struct Entry {
        let id: String
        let title: String
        let subtitle: String
    }

    static func items(_ kind: FeedItem.Kind) -> [Entry] {
        (FeedStore.load().feed?.items(of: kind) ?? []).map { Entry(id: $0.id, title: $0.title, subtitle: $0.subtitle) }
    }

    /// A saved choice stays resolvable after its item leaves the feed, so the
    /// widget can say that it is unavailable instead of silently switching.
    static func resolve(_ identifiers: [String], kind: FeedItem.Kind) -> [Entry] {
        let known = Dictionary(items(kind).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return identifiers.map { known[$0] ?? Entry(id: $0, title: Localization.text("Unavailable"), subtitle: Localization.text("Choose another item")) }
    }
}

struct ResourceSelection: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Choose Resource"
    static let description = IntentDescription("Shows the state and metrics of one resource.")

    @Parameter(title: "Resource")
    var resource: ResourceEntity?
}

struct AgentSelection: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Choose Coding Agent"
    static let description = IntentDescription("Shows the state and usage of one coding agent account.")

    @Parameter(title: "Coding agent")
    var agent: AgentEntity?
}
