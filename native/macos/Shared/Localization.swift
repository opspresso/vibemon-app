import Foundation

/// Text from the widget extension's String Catalog (Widgets/Localizable.xcstrings).
///
/// The catalog has English, Korean, and Japanese. The system picks the
/// language from the macOS preferred languages, as the App does, so the
/// widget's own words match the labels that the App writes to the feed.
enum Localization {
    /// The bundle that contains the catalog. The preview tool has no catalog
    /// of its own; it points this at a language folder of the built extension.
    nonisolated(unsafe) static var bundle = Bundle.main

    static func text(_ key: String.LocalizationValue) -> String {
        String(localized: key, bundle: bundle)
    }
}
