import AppKit
import AppIntents

// Runs against synthetic data and the images in the packaged extension.
let args = CommandLine.arguments
precondition(args.count == 4)
let feedURL = URL(fileURLWithPath: args[1])
WidgetIcons.directory = URL(fileURLWithPath: args[2], isDirectory: true)
let feed = try WidgetFeed.decode(Data(contentsOf: feedURL))
let load = FeedLoad.loaded(feed)

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
for symbol in ["host", "unified", "cluster", "resource"] {
    precondition(NSImage(systemSymbolName: WidgetIcons.resource(symbol), accessibilityDescription: nil) != nil)
}
// The feed loader and future timeline use the same code as the extension.
precondition(FeedStore.load(from: feedURL).feed?.items.count == feed.items.count)
let sample = Samples.item(.agent, now: feed.generatedAt)
let dates = TimelinePlan.dates(for: .item(sample, running: true), now: feed.generatedAt)
precondition(dates.first == feed.generatedAt && dates.count > 1)
precondition(dates == dates.sorted() && Set(dates).count == dates.count)
print("PASS: picker identities/search/images, saved choices, feed/timeline, \(images.count) character images and App icon")
