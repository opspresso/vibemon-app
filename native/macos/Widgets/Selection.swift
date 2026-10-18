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
    let icon: DisplayRepresentation.Image?

    init(_ entry: WidgetCatalog.Entry) {
        id = entry.id
        title = entry.title
        subtitle = entry.subtitle
        icon = .init(systemName: WidgetIcons.resource(entry.symbol))
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)", image: icon)
    }
}

struct AgentEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Coding Agent"
    static let defaultQuery = AgentQuery()

    let id: String
    let title: String
    let subtitle: String
    let icon: DisplayRepresentation.Image?

    init(_ entry: WidgetCatalog.Entry) {
        id = entry.id
        title = entry.title
        subtitle = entry.subtitle
        icon = WidgetIcons.characterURL(entry.artwork).map { .init(url: $0, isTemplate: false) }
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)", image: icon)
    }
}

struct ResourceQuery: EntityStringQuery {
    func entities(for identifiers: [ResourceEntity.ID]) async throws -> [ResourceEntity] {
        WidgetCatalog.resolve(identifiers, kind: .resource).map(ResourceEntity.init)
    }

    func suggestedEntities() async throws -> [ResourceEntity] {
        WidgetCatalog.items(.resource).map(ResourceEntity.init)
    }

    func entities(matching string: String) async throws -> [ResourceEntity] {
        WidgetCatalog.items(.resource, matching: string).map(ResourceEntity.init)
    }

    func defaultResult() async -> ResourceEntity? {
        // No saved ID means automatic selection from the current feed. Do not
        // let WidgetKit cache today's first item as every new widget's choice.
        nil
    }
}

struct AgentQuery: EntityStringQuery {
    func entities(for identifiers: [AgentEntity.ID]) async throws -> [AgentEntity] {
        WidgetCatalog.resolve(identifiers, kind: .agent).map(AgentEntity.init)
    }

    func suggestedEntities() async throws -> [AgentEntity] {
        WidgetCatalog.items(.agent).map(AgentEntity.init)
    }

    func entities(matching string: String) async throws -> [AgentEntity] {
        WidgetCatalog.items(.agent, matching: string).map(AgentEntity.init)
    }

    func defaultResult() async -> AgentEntity? {
        nil
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
