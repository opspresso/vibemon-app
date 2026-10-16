import AppKit
import SwiftUI
import WidgetKit

/// What one widget shows at one moment.
enum WidgetContent: Sendable {
    case item(FeedItem, running: Bool)
    case notice(Notice)
}

/// A short explanation shown when there is no item to display.
struct Notice: Sendable, Equatable {
    let symbol: String
    let title: String
    let detail: String
    /// The Dashboard page that resolves the notice.
    let link: URL

    static let dashboard = URL(string: "vibemon://dashboard/overview")!
    static let resources = URL(string: "vibemon://dashboard/resources")!
    static let agents = URL(string: "vibemon://dashboard/agents")!

    static let appMissing = Notice(symbol: "app.badge", title: "Open VibeMon", detail: "Widgets show data after VibeMon starts.", link: dashboard)
    static let appUnsupported = Notice(symbol: "arrow.clockwise", title: "Restart VibeMon", detail: "The running App and this widget are different versions.", link: dashboard)
    static let feedUnreadable = Notice(symbol: "exclamationmark.triangle", title: "Data unavailable", detail: "Quit and reopen VibeMon to write the widget data again.", link: dashboard)

    static func empty(_ kind: FeedItem.Kind) -> Notice {
        switch kind {
        case .resource:
            Notice(symbol: "server.rack", title: "No resources", detail: "Connect to Web in VibeMon Settings, then choose resources in Customize view.", link: resources)
        case .agent:
            Notice(symbol: "sparkles", title: "No coding agents", detail: "Agents appear after an integration reports activity.", link: agents)
        }
    }

    static func unavailable(_ kind: FeedItem.Kind) -> Notice {
        switch kind {
        case .resource:
            Notice(symbol: "questionmark.square.dashed", title: "Resource unavailable", detail: "It is no longer selected in VibeMon. Edit the widget to choose another.", link: resources)
        case .agent:
            Notice(symbol: "questionmark.square.dashed", title: "Agent unavailable", detail: "It has stopped reporting. Edit the widget to choose another.", link: agents)
        }
    }
}

/// The complete small widget. The host adds the container background.
struct WidgetContentView: View {
    let content: WidgetContent
    let date: Date

    var body: some View {
        switch content {
        case .item(let item, let running):
            ItemView(item: item, status: item.status(at: date), date: date, running: running)
        case .notice(let notice):
            NoticeView(notice: notice)
        }
    }

    /// The tone that tints the widget background.
    var tone: Tone {
        if case .item(let item, _) = content { return item.status(at: date).tone }
        return .neutral
    }
}

/// The widget background: the shared surface with a glow in the state color.
struct ToneBackground: View {
    let tone: Tone

    var body: some View {
        ZStack {
            Palette.surface
            if tone != .neutral {
                RadialGradient(colors: [tone.color.opacity(0.16), .clear], center: .topTrailing, startRadius: 0, endRadius: 150)
            }
        }
    }
}

private struct ItemView: View {
    let item: FeedItem
    let status: FeedStatus
    let date: Date
    let running: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(item: item, status: status, age: Age.text(since: item.observedAt, now: date))
            if let detail {
                Text(detail)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Palette.foreground.opacity(0.78))
                    .lineLimit(item.metrics.isEmpty ? 3 : 1)
                    .padding(.top, 8)
            }
            Spacer(minLength: 8)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(item.metrics.prefix(3)) { MetricRow(metric: $0) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }

    /// After the App quits, the values are the last known ones; otherwise a
    /// resource shows the collector's message.
    private var detail: String? {
        guard running else { return "App closed" }
        return item.kind == .resource ? item.message : nil
    }
}

/// The icon beside the title and the status. The subtitle is spoken only:
/// the widget picker shows it, and the small widget has no room for it.
private struct Header: View {
    let item: FeedItem
    let status: FeedStatus
    let age: String

    var body: some View {
        HStack(spacing: 8) {
            switch item.kind {
            case .agent: CharacterArt(file: item.artwork)
            case .resource: ResourceIcon(symbol: item.symbol)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.foreground)
                    .lineLimit(1)
                    .accessibilityLabel("\(item.title), \(item.subtitle)")
                StatusLine(status: status, age: age)
            }
        }
    }
}

private struct StatusLine: View {
    let status: FeedStatus
    let age: String

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(status.tone.color)
                .frame(width: 7, height: 7)
                .widgetAccentable()
            Text(status.label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(status.tone.color)
                .lineLimit(1)
                // Long labels, such as Needs input, share the row with the age.
                .minimumScaleFactor(0.8)
                .layoutPriority(1)
            Spacer(minLength: 3)
            Text(age)
                .font(.system(size: 10))
                .monospacedDigit()
                .foregroundStyle(Palette.muted)
                .fixedSize()
        }
    }
}

private struct MetricRow: View {
    let metric: FeedMetric

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(metric.label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                Spacer(minLength: 4)
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(metric.value)
                        .font(.system(size: 12, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Palette.foreground)
                    Text(metric.unit)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(Palette.muted)
                }
                .lineLimit(1)
                .layoutPriority(1)
            }
            if let fraction = metric.fraction {
                GaugeBar(fraction: fraction, color: metric.tone.color)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(metric.label)
        .accessibilityValue("\(metric.value)\(metric.unit)")
    }
}

/// A gauge in the metric color on a subtle track. In the vibrant mode, macOS
/// keeps only brightness, so the fill is white on a faint track there.
private struct GaugeBar: View {
    let fraction: Double
    let color: Color
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        let fullColor = renderingMode == .fullColor
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(fullColor ? Palette.subtle : Color.white.opacity(0.15))
                Capsule()
                    .fill(fullColor ? color : Color.white)
                    .frame(width: fraction > 0 ? max(4, geometry.size.width * min(fraction, 1)) : 0)
                    .widgetAccentable()
            }
        }
        .frame(height: 4)
    }
}

private struct ResourceIcon: View {
    let symbol: String?

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Palette.accent)
            .frame(width: 28, height: 28)
            .background(Palette.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .widgetAccentable()
    }

    private var systemName: String {
        switch symbol {
        case "host": "desktopcomputer"
        case "unified": "memorychip"
        case "cluster": "square.stack.3d.up"
        default: "cylinder.split.1x2"
        }
    }
}

/// Pixel-art character from the bundled `characters` folder.
///
/// When the desktop is not focused, macOS draws widgets in the vibrant mode:
/// it keeps only the brightness of each pixel. An opaque tile behind the art
/// then becomes one bright square, so other modes draw the art alone.
struct CharacterArt: View {
    /// Folders searched for character images. The preview tool replaces it.
    nonisolated(unsafe) static var directories: [URL] = [Bundle.main.resourceURL?.appendingPathComponent("characters")].compactMap { $0 }
    static let fallback = "vibemon-v2.png"

    let file: String?
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        let fullColor = renderingMode == .fullColor
        Group {
            if let image = Self.image(named: file) ?? Self.image(named: Self.fallback) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.none)
                    .desaturatedWhenAccented()
                    .aspectRatio(contentMode: .fit)
                    // Light characters, such as Kiro, need an edge on a light tile.
                    .shadow(color: fullColor ? Palette.foreground.opacity(0.35) : .clear, radius: 0.6)
                    .padding(fullColor ? 3 : 1)
            }
        }
        .frame(width: 28, height: 28)
        .background(fullColor ? Palette.subtle : .clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .accessibilityHidden(true)
    }

    private static func image(named file: String?) -> NSImage? {
        // Registry file names are plain names; reject paths.
        guard let file, !file.contains("/") else { return nil }
        for directory in directories {
            if let image = NSImage(contentsOf: directory.appendingPathComponent(file)) { return image }
        }
        return nil
    }
}

private extension Image {
    /// Keeps the art in gray instead of one accent color where macOS supports it.
    @ViewBuilder
    func desaturatedWhenAccented() -> some View {
        if #available(macOS 15, *) {
            widgetAccentedRenderingMode(.desaturated)
        } else {
            self
        }
    }
}

private struct NoticeView: View {
    let notice: Notice

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: notice.symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Palette.accent)
                .widgetAccentable()
            Spacer(minLength: 8)
            Text(notice.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.foreground)
                .lineLimit(2)
            Text(notice.detail)
                .font(.system(size: 10.5))
                .foregroundStyle(Palette.muted)
                .lineLimit(4)
                .padding(.top, 3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}

/// Compact report age at minute precision, matching the widget's refresh steps.
enum Age {
    static func text(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<60: return "now"
        case ..<3600: return "\(seconds / 60)m"
        case ..<86400: return "\(seconds / 3600)h"
        default: return "\(seconds / 86400)d"
        }
    }
}
