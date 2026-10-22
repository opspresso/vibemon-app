// vibemon-widget-preview: renders widget states to one PNG sheet.
//
// The sheet shows every feed item and every notice in light and dark
// appearance at the macOS small widget size, then once more in the vibrant
// mode that macOS uses when the desktop is not focused. The vibrant column is
// an approximation: it keeps the brightness of each pixel as white. Use the
// sheet to review layout changes and to verify that a feed decodes.
//
// Usage: [VIBEMON_LOCALE=ko] vibemon-widget-preview <feed.json> <characters-dir> <output.png> [<now ISO 8601>]

import AppKit
import SwiftUI
import WidgetKit

let arguments = CommandLine.arguments
guard (4...5).contains(arguments.count) else {
    FileHandle.standardError.write(Data("usage: vibemon-widget-preview <feed.json> <characters-dir> <output.png> [<now>]\n".utf8))
    exit(2)
}

let feed: WidgetFeed
do {
    feed = try WidgetFeed.decode(Data(contentsOf: URL(fileURLWithPath: arguments[1])))
} catch {
    FileHandle.standardError.write(Data("cannot decode feed: \(error)\n".utf8))
    exit(1)
}
WidgetIcons.directory = URL(fileURLWithPath: arguments[2], isDirectory: true)
// The widget's own words come from the String Catalog of the extension built
// next to this tool. VIBEMON_LOCALE (en, ko, or ja) picks its language.
if let language = ProcessInfo.processInfo.environment["VIBEMON_LOCALE"],
   let folder = Bundle.main.executableURL?.deletingLastPathComponent()
       .appendingPathComponent("VibeMonWidgets.appex/Contents/Resources/\(language).lproj"),
   let bundle = Bundle(url: folder) {
    Localization.bundle = bundle
}
let now = arguments.count == 5 ? (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(arguments[4])) ?? feed.generatedAt : feed.generatedAt

// After the feed items: notices and the gallery samples.
let contents: [WidgetContent] = feed.items.map { .item($0) }
    + [.notice(.appMissing), .notice(.empty(.resource)), .notice(.unavailable(.agent))]
    + [.item(Samples.item(.resource, now: now)), .item(Samples.item(.agent, now: now))]

struct Tile: View {
    let content: WidgetContent
    let date: Date
    let vibrant: Bool

    var body: some View {
        let view = WidgetContentView(content: content, date: date)
        let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
        if vibrant {
            // macOS removes the container background and keeps brightness only.
            view
                .environment(\.widgetRenderingMode, .vibrant)
                .padding(16)
                .frame(width: 170, height: 170)
                // Flatten onto black first: the filter ignores the alpha of each layer.
                .background(Color.black)
                .compositingGroup()
                .luminanceToAlpha()
                .colorInvert()
                .background(Color.white.opacity(0.08), in: shape)
        } else {
            view
                .padding(16)
                .frame(width: 170, height: 170)
                .background(ToneBackground(tone: view.tone))
                .clipShape(shape)
                .overlay(shape.strokeBorder(Palette.border, lineWidth: 0.5))
        }
    }
}

struct Sheet: View {
    let scheme: ColorScheme
    let vibrant: Bool

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(170), spacing: 20), count: 4), spacing: 20) {
            ForEach(contents.indices, id: \.self) { Tile(content: contents[$0], date: now, vibrant: vibrant) }
        }
        .padding(24)
        .background(vibrant ? Color(white: 0.28) : Palette.background)
        .environment(\.colorScheme, scheme)
    }
}

@MainActor
func render(_ scheme: ColorScheme, appearance: NSAppearance.Name, vibrant: Bool = false) -> CGImage? {
    var image: CGImage?
    NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
        let renderer = ImageRenderer(content: Sheet(scheme: scheme, vibrant: vibrant))
        renderer.scale = 2
        image = renderer.cgImage
    }
    return image
}

guard let light = render(.light, appearance: .aqua),
      let dark = render(.dark, appearance: .darkAqua),
      let vibrant = render(.dark, appearance: .darkAqua, vibrant: true) else {
    FileHandle.standardError.write(Data("cannot render preview\n".utf8))
    exit(1)
}
let columns = [light, dark, vibrant]
let width = columns.reduce(0) { $0 + $1.width }
let height = columns.map(\.height).max() ?? 0
guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
var x = 0
for column in columns {
    context.draw(column, in: CGRect(x: x, y: height - column.height, width: column.width, height: column.height))
    x += column.width
}
guard let sheet = context.makeImage(),
      let data = NSBitmapImageRep(cgImage: sheet).representation(using: .png, properties: [:]) else { exit(1) }
do {
    try data.write(to: URL(fileURLWithPath: arguments[3]))
} catch {
    FileHandle.standardError.write(Data("cannot write \(arguments[3]): \(error)\n".utf8))
    exit(1)
}
print("rendered \(contents.count) widget(s) to \(arguments[3])")
