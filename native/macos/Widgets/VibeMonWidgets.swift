import AppIntents
import SwiftUI
import WidgetKit

@main
struct VibeMonWidgets: WidgetBundle {
    var body: some Widget {
        ResourceWidget()
        AgentWidget()
    }
}

/// Widget kinds. VibeMon reloads both after it writes a new feed.
enum WidgetKind {
    static let resource = "com.opspresso.vibemon.widget.resource"
    static let agent = "com.opspresso.vibemon.widget.agent"
}

struct ResourceWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetKind.resource, intent: ResourceSelection.self, provider: Provider<ResourceSelection>(kind: .resource)) { entry in
            EntryView(entry: entry)
        }
        .configurationDisplayName("Resource")
        .description("State and metrics of one resource from your VibeMon workspace.")
        .supportedFamilies([.systemSmall])
    }
}

struct AgentWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetKind.agent, intent: AgentSelection.self, provider: Provider<AgentSelection>(kind: .agent)) { entry in
            EntryView(entry: entry)
        }
        .configurationDisplayName("Coding Agent")
        .description("State and usage of one coding agent account.")
        .supportedFamilies([.systemSmall])
    }
}

/// The saved item ID of a widget configuration.
protocol ItemSelection: WidgetConfigurationIntent {
    var itemID: String? { get }
}

extension ResourceSelection: ItemSelection {
    var itemID: String? { resource?.id }
}

extension AgentSelection: ItemSelection {
    var itemID: String? { agent?.id }
}

struct Entry: TimelineEntry {
    let date: Date
    let content: WidgetContent
}

struct Provider<Selection: ItemSelection>: AppIntentTimelineProvider {
    let kind: FeedItem.Kind

    func placeholder(in context: Context) -> Entry {
        Entry(date: .now, content: .item(Samples.item(kind), running: true))
    }

    func snapshot(for configuration: Selection, in context: Context) async -> Entry {
        let content = content(for: configuration)
        // The gallery shows an example until VibeMon has an item of this kind.
        if context.isPreview, case .notice = content {
            return Entry(date: .now, content: .item(Samples.item(kind), running: true))
        }
        return Entry(date: .now, content: content)
    }

    func timeline(for configuration: Selection, in context: Context) async -> Timeline<Entry> {
        let now = Date.now
        let content = content(for: configuration)
        let entries = TimelinePlan.dates(for: content, now: now).map { Entry(date: $0, content: content) }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(TimelinePlan.horizon)))
    }

    private func content(for configuration: Selection) -> WidgetContent {
        WidgetContent.resolve(FeedStore.load(), kind: kind, selection: configuration.itemID)
    }
}

struct EntryView: View {
    let entry: Entry

    var body: some View {
        let view = WidgetContentView(content: entry.content, date: entry.date)
        view
            .containerBackground(for: .widget) { ToneBackground(tone: view.tone) }
            .widgetURL(link)
    }

    private var link: URL {
        switch entry.content {
        case .item(let item, _): item.link
        case .notice(let notice): notice.link
        }
    }
}
