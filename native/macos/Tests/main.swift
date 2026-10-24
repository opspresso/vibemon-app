import AppKit
import AppIntents
import SwiftUI
import WidgetKit

// Runs against synthetic data and the images in the packaged extension.
let args = CommandLine.arguments
precondition(args.count == 4)
let feedURL = URL(fileURLWithPath: args[1])
WidgetIcons.directory = URL(fileURLWithPath: args[2], isDirectory: true)
let feed = try WidgetFeed.decode(Data(contentsOf: feedURL))
for metric in feed.items.flatMap(\.metrics) {
    if let parts = metric.valueParts {
        precondition(parts.integer + parts.fraction == metric.value, "Semantic segments changed the reading")
    }
}
let oldMetric = try JSONDecoder().decode(FeedMetric.self, from: Data(#"{"key":"latency","label":"Latency","value":"12.4","unit":" ms","tone":"normal"}"#.utf8))
precondition(oldMetric.value == "12.4" && oldMetric.valueParts == nil, "An older version 2 feed must remain readable")
let load = FeedLoad.loaded(feed)
let defaultAgent = await AgentQuery().defaultResult()
let defaultResource = await ResourceQuery().defaultResult()
precondition(defaultAgent == nil && defaultResource == nil, "A new widget must not save a potentially stale account ID")
guard case .item(let automatic) = WidgetContent.resolve(load, kind: .agent, selection: nil) else {
    fatalError("A new coding widget did not select current data")
}
precondition(automatic.metrics.contains { $0.value != "—" }, "New coding widget has no fixture metrics")

for kind in [FeedItem.Kind.resource, .agent] {
    let entries = WidgetCatalog.items(kind, from: load)
    precondition(!entries.isEmpty)
    for entry in entries {
        precondition(!entry.title.isEmpty)
        precondition(WidgetCatalog.items(kind, from: load, matching: entry.id).map(\.id) == [entry.id])
        let resolved = WidgetCatalog.resolve([entry.id], kind: kind, from: load)
        precondition(resolved.first?.id == entry.id)
        let image = kind == .agent ? AgentEntity(entry).displayRepresentation.image : ResourceEntity(entry).displayRepresentation.image
        precondition(image != nil, "Picker image missing")
        guard case .item(let item) = WidgetContent.resolve(load, kind: kind, selection: entry.id) else {
            fatalError("Saved choice did not resolve")
        }
        precondition(item.id == entry.id)
    }
    let removed = WidgetCatalog.resolve(["removed"], kind: kind, from: load)
    precondition(removed.first?.id == "removed")
    guard case .notice = WidgetContent.resolve(load, kind: kind, selection: "removed") else {
        fatalError("A removed choice silently switched")
    }
}
let agents = WidgetCatalog.items(.agent, from: load)
precondition(Set(agents.map(\.title)).count == agents.count, "Accounts have ambiguous picker titles")
precondition(WidgetCatalog.items(.agent, from: load, matching: "cOdEx").count == 2)
let project = feed.items.first { $0.kind == .agent }!.selectionSubtitle!
precondition(!WidgetCatalog.items(.agent, from: load, matching: project).isEmpty)
precondition(WidgetCatalog.items(.agent, from: .missing).isEmpty)
precondition(WidgetIcons.imageURL("../icon.png") == nil)
precondition(WidgetIcons.characterURL("not-bundled.png")?.lastPathComponent == WidgetIcons.fallback)
precondition(WidgetIcons.characterImage("not-bundled.png")?.isValid == true)

func visibleImage(_ url: URL) {
    guard let image = NSImage(contentsOf: url), image.isValid,
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fatalError("Cannot decode bundled image: \(url.lastPathComponent)")
    }
    let bitmap = NSBitmapImageRep(cgImage: cg)
    var visible = false
    for y in 0..<bitmap.pixelsHigh where !visible {
        for x in 0..<bitmap.pixelsWide where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 {
            visible = true
            break
        }
    }
    precondition(visible, "Empty image: \(url.lastPathComponent)")
}
let images = try FileManager.default.contentsOfDirectory(at: WidgetIcons.directory!, includingPropertiesForKeys: nil).filter { $0.pathExtension == "png" }
precondition(!images.isEmpty)
for image in images { visibleImage(image) }
visibleImage(URL(fileURLWithPath: args[3]))
@MainActor
func verifyIcon(_ view: some View, mode: WidgetRenderingMode) {
    let renderer = ImageRenderer(content: view.environment(\.widgetRenderingMode, mode))
    renderer.scale = 3
    guard let cg = renderer.cgImage else { fatalError("Cannot render widget icon") }
    let bitmap = NSBitmapImageRep(cgImage: cg)
    let edge = bitmap.colorAt(x: 1, y: bitmap.pixelsHigh / 2)!.alphaComponent
    precondition(mode == .fullColor ? edge > 0 : edge == 0, "Opaque icon tile in monochrome mode")
    precondition((0..<bitmap.pixelsHigh).contains { y in
        (0..<bitmap.pixelsWide).contains { x in bitmap.colorAt(x: x, y: y)!.alphaComponent > 0.5 }
    }, "Widget icon disappeared")
}
for mode in [WidgetRenderingMode.fullColor, .accented, .vibrant] {
    for symbol in ["host", "unified", "cluster", "resource"] {
        precondition(NSImage(systemSymbolName: WidgetIcons.resource(symbol), accessibilityDescription: nil) != nil)
        verifyIcon(ResourceIcon(symbol: symbol), mode: mode)
    }
    for image in images { verifyIcon(CharacterArt(file: image.lastPathComponent), mode: mode) }
}

@MainActor
func statusPixels(_ status: FeedStatus, age: String) -> NSBitmapImageRep {
    let view = StatusLine(status: status, age: age)
        .frame(width: 130, height: 18, alignment: .leading)
        .environment(\.colorScheme, .light)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 3
    guard let image = renderer.cgImage else { fatalError("Cannot render widget status") }
    return NSBitmapImageRep(cgImage: image)
}

/// Visible pixels to the right of the 7-point dot: the label and the age.
func textPixels(_ bitmap: NSBitmapImageRep) -> [NSColor] {
    (30..<bitmap.pixelsWide).flatMap { x in
        (0..<bitmap.pixelsHigh).compactMap { y in
            let pixel = bitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
            return pixel.alphaComponent > 0.5 ? pixel : nil
        }
    }
}

// Standby uses the same layout as every other state: a label and an age in
// the neutral color, never a warning.
guard let resource = feed.items.first(where: { $0.kind == .resource && $0.status(at: feed.generatedAt).state == "standby" }) else {
    fatalError("A standby resource fixture is required")
}
let standby = resource.status(at: feed.generatedAt)
precondition(standby.tone == .neutral, "Standby must use the neutral tone")
let standbyText = textPixels(statusPixels(standby, age: "3m"))
precondition(!standbyText.isEmpty, "Standby must show its label and age")
// The muted slate has more blue than red; the amber warning color has less.
precondition(standbyText.allSatisfy { $0.blueComponent >= $0.redComponent }, "Standby must use the muted neutral color, not a warning color")
let warningText = textPixels(statusPixels(FeedStatus(at: feed.generatedAt, state: "warning", label: standby.label, tone: .warning), age: "3m"))
precondition(warningText.contains { $0.redComponent > $0.blueComponent + 0.2 }, "The color check must detect the warning color")
let errorText = textPixels(statusPixels(FeedStatus(at: feed.generatedAt, state: "error", label: "Error", tone: .danger), age: "3m"))
precondition(!errorText.isEmpty, "Reported errors must retain their label and age")

// The feed loader and future timeline use the same code as the extension.
precondition(FeedStore.load(from: feedURL).feed?.items.count == feed.items.count)
let sample = Samples.item(.agent, now: feed.generatedAt)
let dates = TimelinePlan.dates(for: .item(sample), now: feed.generatedAt)
precondition(dates.first == feed.generatedAt && dates.count > 1)
precondition(dates == dates.sorted() && Set(dates).count == dates.count)
print("PASS: picker identities/search/images, saved choices, feed/timeline, \(images.count) character images and App icon")
