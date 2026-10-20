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
let load = FeedLoad.loaded(feed)
let defaultAgent = await AgentQuery().defaultResult()
let defaultResource = await ResourceQuery().defaultResult()
precondition(defaultAgent == nil && defaultResource == nil, "A new widget must not save a potentially stale account ID")
guard case .item(let automatic, _) = WidgetContent.resolve(load, kind: .agent, selection: nil) else {
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
        guard case .item(let item, _) = WidgetContent.resolve(load, kind: kind, selection: entry.id) else {
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
func statusPixels(_ state: String, label: String, age: String, running: Bool) -> NSBitmapImageRep {
    let status = FeedStatus(at: feed.generatedAt, state: state, label: label, tone: state == "stale" ? .warning : .danger)
    let view = StatusLine(status: status, age: age, running: running)
        .frame(width: 130, height: 18, alignment: .leading)
        .environment(\.colorScheme, .light)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 3
    guard let image = renderer.cgImage else { fatalError("Cannot render widget status") }
    return NSBitmapImageRep(cgImage: image)
}

let stale = statusPixels("stale", label: "응답 없음", age: "now", running: true)
let old = statusPixels("stale", label: "Stale", age: "99d", running: false)
var statusDotPixels = 0
for y in 0..<stale.pixelsHigh {
    for x in 0..<stale.pixelsWide {
        let pixel = stale.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
        let other = old.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
        precondition(pixel == other, "Stale widget status must not show a label, age, or closed-App mark")
        if pixel.alphaComponent > 0.5 {
            statusDotPixels += 1
            precondition(x < 24, "Only the 7-point status dot may be visible")
            precondition(pixel.redComponent > pixel.blueComponent && pixel.greenComponent > pixel.blueComponent, "Stale status must use the yellow warning color")
        }
    }
}
precondition(statusDotPixels > 0, "The stale status dot must remain visible")
let errorStatus = statusPixels("error", label: "Error", age: "3m", running: true)
precondition((30..<errorStatus.pixelsWide).contains { x in
    (0..<errorStatus.pixelsHigh).contains { y in errorStatus.colorAt(x: x, y: y)!.alphaComponent > 0.5 }
}, "Reported errors must retain their label and age")

@MainActor
func resourceImage(_ item: FeedItem, date: Date) -> NSBitmapImageRep {
    let view = WidgetContentView(content: .item(item, running: true), date: date)
        .padding(16)
        .frame(width: 170, height: 170)
        .background(Palette.surface)
        .environment(\.colorScheme, .light)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 3
    guard let image = renderer.cgImage else {
        fatalError("Cannot render resource timestamp")
    }
    return NSBitmapImageRep(cgImage: image)
}

func samePixels(_ lhs: NSBitmapImageRep, _ rhs: NSBitmapImageRep) -> Bool {
    guard lhs.pixelsWide == rhs.pixelsWide && lhs.pixelsHigh == rhs.pixelsHigh else { return false }
    var largest = 0.0
    for y in 0..<lhs.pixelsHigh {
        for x in 0..<lhs.pixelsWide {
            let a = lhs.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
            let b = rhs.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
            let delta = max(abs(a.redComponent - b.redComponent), abs(a.greenComponent - b.greenComponent), abs(a.blueComponent - b.blueComponent), abs(a.alphaComponent - b.alphaComponent))
            largest = max(largest, delta)
        }
    }
    // SwiftUI color conversion can vary by two 8-bit levels between renders.
    return largest <= 2.0 / 255
}

guard let resource = feed.items.first(where: { $0.kind == .resource && $0.status(at: feed.generatedAt).state == "stale" }) else {
    fatalError("A stale resource fixture is required")
}
do {
    var object = try JSONSerialization.jsonObject(with: Data(contentsOf: feedURL)) as! [String: Any]
    var items = object["items"] as! [[String: Any]]
    let index = items.firstIndex { $0["id"] as? String == resource.id }!
    items[index]["observedAt"] = resource.observedAt.addingTimeInterval(-86400).formatted(.iso8601)
    object["items"] = items
    let older = try WidgetFeed.decode(JSONSerialization.data(withJSONObject: object)).item(id: resource.id)!
    let original = resourceImage(resource, date: feed.generatedAt)
    let delayed = resourceImage(resource, date: feed.generatedAt.addingTimeInterval(7200))
    precondition(samePixels(original, delayed), "The receipt timestamp must remain factual between refreshes")
    precondition(!samePixels(original, resourceImage(older, date: feed.generatedAt)), "The report date must be visible")
}
// The feed loader and future timeline use the same code as the extension.
precondition(FeedStore.load(from: feedURL).feed?.items.count == feed.items.count)
let sample = Samples.item(.agent, now: feed.generatedAt)
let dates = TimelinePlan.dates(for: .item(sample, running: true), now: feed.generatedAt)
precondition(dates.first == feed.generatedAt && dates.count > 1)
precondition(dates == dates.sorted() && Set(dates).count == dates.count)
print("PASS: picker identities/search/images, saved choices, feed/timeline, \(images.count) character images and App icon")
