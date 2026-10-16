// vibemon-widget-preview: renders widget states to one PNG sheet.
//
// The sheet shows every feed item and every notice in light and dark
// appearance at the macOS small widget size. Use it to review layout
// changes and to verify that a feed decodes.
//
// Usage: vibemon-widget-preview <feed.json> <characters-dir> <output.png> [<now ISO 8601>]

import AppKit
import SwiftUI

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
CharacterArt.directories = [URL(fileURLWithPath: arguments[2], isDirectory: true)]
let now = arguments.count == 5 ? (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(arguments[4])) ?? feed.generatedAt : feed.generatedAt

// The last tile shows the first item as it looks after the App quits.
let contents: [WidgetContent] = feed.items.map { .item($0, running: feed.running) }
    + [.notice(.appMissing), .notice(.empty(.resource)), .notice(.unavailable(.agent))]
    + feed.items.prefix(1).map { .item($0, running: false) }

struct Tile: View {
    let content: WidgetContent
    let date: Date

    var body: some View {
        let view = WidgetContentView(content: content, date: date)
        view
            .padding(16)
            .frame(width: 170, height: 170)
            .background(ToneBackground(tone: view.tone))
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.border, lineWidth: 0.5))
    }
}

struct Sheet: View {
    let scheme: ColorScheme

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(170), spacing: 20), count: 4), spacing: 20) {
            ForEach(contents.indices, id: \.self) { Tile(content: contents[$0], date: now) }
        }
        .padding(24)
        .background(Palette.background)
        .environment(\.colorScheme, scheme)
    }
}

@MainActor
func render(_ scheme: ColorScheme, appearance: NSAppearance.Name) -> CGImage? {
    var image: CGImage?
    NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
        let renderer = ImageRenderer(content: Sheet(scheme: scheme))
        renderer.scale = 2
        image = renderer.cgImage
    }
    return image
}

guard let light = render(.light, appearance: .aqua), let dark = render(.dark, appearance: .darkAqua) else {
    FileHandle.standardError.write(Data("cannot render preview\n".utf8))
    exit(1)
}
let width = light.width + dark.width
let height = max(light.height, dark.height)
guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
context.draw(light, in: CGRect(x: 0, y: height - light.height, width: light.width, height: light.height))
context.draw(dark, in: CGRect(x: light.width, y: height - dark.height, width: dark.width, height: dark.height))
guard let sheet = context.makeImage(),
      let data = NSBitmapImageRep(cgImage: sheet).representation(using: .png, properties: [:]) else { exit(1) }
do {
    try data.write(to: URL(fileURLWithPath: arguments[3]))
} catch {
    FileHandle.standardError.write(Data("cannot write \(arguments[3]): \(error)\n".utf8))
    exit(1)
}
print("rendered \(contents.count) widget(s) to \(arguments[3])")
