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

    static var appMissing: Notice {
        Notice(symbol: "app.badge", title: Localization.text("Open VibeMon"), detail: Localization.text("Widgets show data after VibeMon starts."), link: dashboard)
    }
    static var appUnsupported: Notice {
        Notice(symbol: "arrow.clockwise", title: Localization.text("Restart VibeMon"), detail: Localization.text("The running App and this widget are different versions."), link: dashboard)
    }
    static var feedUnreadable: Notice {
        Notice(symbol: "exclamationmark.triangle", title: Localization.text("Data unavailable"), detail: Localization.text("Quit and reopen VibeMon to write the widget data again."), link: dashboard)
    }

    static func empty(_ kind: FeedItem.Kind) -> Notice {
        switch kind {
        case .resource:
            Notice(symbol: "server.rack", title: Localization.text("No resources"), detail: Localization.text("Connect to Web in VibeMon Settings, then choose resources in Customize view."), link: resources)
        case .agent:
            Notice(symbol: "sparkles", title: Localization.text("No coding agents"), detail: Localization.text("Agents appear after an integration reports activity."), link: agents)
        }
    }

    static func unavailable(_ kind: FeedItem.Kind) -> Notice {
        switch kind {
        case .resource:
            Notice(symbol: "questionmark.square.dashed", title: Localization.text("Resource unavailable"), detail: Localization.text("It is no longer selected in VibeMon. Edit the widget to choose another."), link: resources)
        case .agent:
            Notice(symbol: "questionmark.square.dashed", title: Localization.text("Choose coding account"), detail: Localization.text("The saved account is no longer available. Edit this widget and select a current account."), link: agents)
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
                RadialGradient(colors: [tone.color.opacity(0.18), .clear], center: .topTrailing, startRadius: 0, endRadius: 160)
            }
        }
    }
}

/// The layout matches the iPhone small widget: header, status line, then
/// metrics lifted slightly off the bottom edge.
private struct ItemView: View {
    let item: FeedItem
    let status: FeedStatus
    let date: Date
    let running: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Header(item: item, lastReceivedAt: status.state == "stale" ? item.observedAt : nil)
            StatusLine(status: status, age: Age.text(since: item.observedAt, now: date), running: running)
            // A resource message explains its state, so it takes the place of one metric.
            let message = item.kind == .resource ? item.message : nil
            if let message {
                Text(message)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Palette.foreground.opacity(0.8))
                    .lineLimit(item.metrics.isEmpty ? 3 : 1)
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(item.metrics.prefix(message == nil ? 3 : 2)) { MetricRow(metric: $0, date: date) }
            }
            .padding(.bottom, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}

/// The icon, the title, and the subtitle.
private struct Header: View {
    let item: FeedItem
    let lastReceivedAt: Date?

    var body: some View {
        HStack(spacing: 8) {
            switch item.kind {
            case .agent: CharacterArt(file: item.artwork)
            case .resource: ResourceIcon(symbol: item.symbol)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(item.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.foreground)
                    .lineLimit(1)
                if let lastReceivedAt {
                    let stamp = lastReceivedAt.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute())
                    ViewThatFits(in: .horizontal) {
                        Text("\(item.subtitle) · \(stamp)")
                        Text(stamp)
                    }
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(String(format: Localization.text("Last report received: %@"), stamp))
                } else {
                    Text(item.subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }
            }
        }
    }
}

/// Stale data gets only a warning dot: a delayed widget refresh does not prove
/// that the resource stopped responding. Other states keep their label and age.
struct StatusLine: View {
    let status: FeedStatus
    let age: String
    let running: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(status.tone.color)
                .frame(width: 7, height: 7)
                .widgetAccentable()
                .accessibilityElement()
                .accessibilityLabel(Localization.text("Saved data"))
                .accessibilityHidden(status.state != "stale")
            if status.state != "stale" {
                Text(status.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(status.tone.color)
                    .lineLimit(1)
                    // Long labels, such as Needs input, share the row with the age.
                    .minimumScaleFactor(0.8)
                    .layoutPriority(1)
                Spacer(minLength: 3)
                if !running {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Palette.muted)
                        .accessibilityLabel(Localization.text("Saved data"))
                }
                Text(age)
                    .font(.system(size: 10))
                    .monospacedDigit()
                    .foregroundStyle(Palette.muted)
                    .fixedSize()
            }
        }
        .frame(minHeight: 14, alignment: .leading)
    }
}

private struct MetricRow: View {
    let metric: FeedMetric
    let date: Date

    var body: some View {
        let countdown = metric.resetsAt.map { Countdown.text(until: $0, now: date) }
        VStack(alignment: .leading, spacing: 3) {
            // The reset countdown gives way when the row is too narrow for it.
            ViewThatFits(in: .horizontal) {
                header(countdown: countdown)
                header(countdown: nil)
            }
            if let fraction = metric.fraction {
                GaugeBar(fraction: fraction, color: metric.tone.color)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(metric.label)
        .accessibilityValue(metric.resetsAt.map { "\(metric.value)\(metric.unit), \(Countdown.sentence(until: $0, now: date))" } ?? "\(metric.value)\(metric.unit)")
    }

    private func header(countdown: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(metric.label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
            if let countdown {
                HStack(alignment: .firstTextBaseline, spacing: 1) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 7, weight: .semibold))
                    Text(countdown)
                        .monospacedDigit()
                }
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(Palette.muted)
                .fixedSize()
            }
            Spacer(minLength: 4)
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(metric.value)
                    .font(.system(size: 12.5, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Palette.foreground)
                Text(metric.unit)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(Palette.muted)
            }
            .fixedSize()
        }
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

struct ResourceIcon: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let symbol: String?

    var body: some View {
        Image(systemName: WidgetIcons.resource(symbol))
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Palette.accent)
            .frame(width: 30, height: 30)
            .background(renderingMode == .fullColor ? Palette.accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .widgetAccentable()
    }
}

/// Character art from the bundled `characters` folder, in a 30-point tile.
///
/// When the desktop is not focused, macOS draws widgets in the vibrant mode:
/// it keeps only the brightness of each pixel. An opaque tile behind the art
/// then becomes one bright square, so other modes draw the art alone.
struct CharacterArt: View {
    let file: String?
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        let fullColor = renderingMode == .fullColor
        Group {
            if let image = WidgetIcons.characterImage(file) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .desaturatedWhenAccented()
                    .aspectRatio(contentMode: .fit)
                    // Light characters, such as Kiro, need an edge on a light tile.
                    .shadow(color: fullColor ? Palette.foreground.opacity(0.35) : .clear, radius: 0.6)
                    .padding(fullColor ? 3 : 1)
            }
        }
        .frame(width: 30, height: 30)
        .background(fullColor ? Palette.subtle : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityHidden(true)
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

/// Report age at minute precision, worded like age.* in
/// src/shared/i18n/shared.json and the iPhone widgets.
enum Age {
    static func text(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<60: return Localization.text("Just now")
        case ..<3600: return Localization.text("\(seconds / 60)m ago")
        case ..<86400: return Localization.text("\(seconds / 3600)h ago")
        default: return Localization.text("\(seconds / 86400)d ago")
        }
    }
}

/// Time left until a plan usage limit resets. It matches `formatResetTime` in
/// `src/shared/design/presentation.mjs` and duration.* and reset.* in
/// src/shared/i18n/shared.json: in English "now", "24m", "2h5m", or "3d4h".
enum Countdown {
    static func minutes(until date: Date, now: Date) -> Int {
        max(0, Int((date.timeIntervalSince(now) / 60).rounded(.up)))
    }

    static func text(until date: Date, now: Date) -> String {
        let minutes = minutes(until: date, now: now)
        switch minutes {
        case 0: return Localization.text("now")
        case ..<60: return Localization.text("\(minutes)m")
        case ..<1440:
            let (hours, rest) = (minutes / 60, minutes % 60)
            return rest == 0 ? Localization.text("\(hours)h") : Localization.text("\(hours)h\(rest)m")
        default:
            let (days, hours) = (minutes / 1440, minutes % 1440 / 60)
            return hours == 0 ? Localization.text("\(days)d") : Localization.text("\(days)d\(hours)h")
        }
    }

    /// The countdown as a sentence for assistive technology.
    static func sentence(until date: Date, now: Date) -> String {
        minutes(until: date, now: now) == 0 ? Localization.text("Resets now") : Localization.text("Resets in \(text(until: date, now: now))")
    }
}
