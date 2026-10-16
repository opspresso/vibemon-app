import Foundation

/// Example items for the widget gallery and placeholders, before VibeMon has
/// written data that the widget can show.
enum Samples {
    static func item(_ kind: FeedItem.Kind, now: Date = .now) -> FeedItem {
        let at = now.formatted(.iso8601)
        let json = switch kind {
        case .resource: """
            {"id":"sample:resource","kind":"resource","title":"Build server","subtitle":"Host","symbol":"host","observedAt":"\(at)",
             "metrics":[{"key":"cpu","label":"CPU","value":"42","unit":"%","fraction":0.42,"tone":"normal"},
                        {"key":"memory","label":"Memory","value":"68","unit":"%","fraction":0.68,"tone":"normal"},
                        {"key":"gpu","label":"GPU","value":"17","unit":"%","fraction":0.17,"tone":"normal"}],
             "timeline":[{"at":"\(at)","state":"ok","label":"Healthy","tone":"good"}],"link":"vibemon://dashboard/resources"}
            """
        case .agent: """
            {"id":"sample:agent","kind":"agent","title":"Claude Code","subtitle":"default","artwork":"clawd.png","observedAt":"\(at)",
             "metrics":[{"key":"context","label":"Context","value":"34","unit":"%","fraction":0.34,"tone":"normal"},
                        {"key":"session","label":"Session","value":"48","unit":"%","fraction":0.48,"tone":"normal"},
                        {"key":"week","label":"Weekly","value":"72","unit":"%","fraction":0.72,"tone":"warning"}],
             "timeline":[{"at":"\(at)","state":"working","label":"Working","tone":"active","project":"my-project"}],"link":"vibemon://dashboard/agents"}
            """
        }
        // The literals above are fixed and valid; a decoding failure is a programming error.
        return try! WidgetFeed.decode(Data(#"{"version":1,"generatedAt":"\#(at)","running":true,"items":[\#(json)]}"#.utf8)).items[0]
    }
}
