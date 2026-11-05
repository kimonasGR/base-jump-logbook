import SwiftUI

@main
struct FlySightLogbookApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                NavigationStack {
                    WebLogbookView()
                        .toolbar(.hidden, for: .navigationBar)
                }
                .tabItem {
                    Label("Logbook", systemImage: "book.closed")
                }

                FlySightConnectionView()
                    .tabItem {
                        Label("FlySight", systemImage: "antenna.radiowaves.left.and.right")
                    }
            }
            .tint(Color(red: 0.35, green: 0.58, blue: 1.0))
        }
    }
}
