import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let port = ProcessInfo.processInfo.environment["MONITOR_PORT"] ?? "3899"
        let url = URL(string: "http://127.0.0.1:\(port)/widget")!

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Codex Discord Bridge Widget"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true
        window.collectionBehavior = [.fullScreenAuxiliary]
        window.setFrameAutosaveName("OOBridgeWidgetWindow")
        window.minSize = NSSize(width: 320, height: 440)

        let effectView = NSVisualEffectView(frame: window.contentView?.bounds ?? .zero)
        effectView.autoresizingMask = [.width, .height]
        effectView.blendingMode = .behindWindow
        effectView.material = .hudWindow
        effectView.state = .active
        effectView.wantsLayer = true
        effectView.layer?.cornerRadius = 28
        effectView.layer?.masksToBounds = true

        let configuration = WKWebViewConfiguration()
        configuration.suppressesIncrementalRendering = false

        let webView = WKWebView(frame: effectView.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: url))

        effectView.addSubview(webView)
        window.contentView = effectView
        window.center()
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)

        self.window = window
        self.webView = webView
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
