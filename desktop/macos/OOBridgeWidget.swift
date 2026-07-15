import Cocoa
import WebKit

struct CommandResult {
    let status: Int32
    let output: String
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var projectRoot: URL?
    private var monitorPort = "3899"

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupWindow()

        guard let root = resolveProjectRoot() else {
            loadError(
                "找不到專案資料夾",
                "這個 app 不知道 oo-bridge 專案放在哪裡。請重新執行 npm run desktop:mac 建立 app。"
            )
            return
        }

        projectRoot = root
        monitorPort = readEnvValue("MONITOR_PORT", root: root)
            ?? ProcessInfo.processInfo.environment["MONITOR_PORT"]
            ?? "3899"

        loadStatus("正在啟動橋接", "我會先確認環境，再打開橋接狀態小窗。")
        startBridge(root: root)
    }

    private func setupWindow() {
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

        effectView.addSubview(webView)
        window.contentView = effectView
        window.center()
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)

        self.window = window
        self.webView = webView
    }

    private func startBridge(root: URL) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.prepareProject(root: root)

                self.loadStatus("正在啟動 Discord bridge", "背景服務會跑在 tmux session 裡。")
                let bridge = self.runScript("scripts/start-tmux.sh", root: root)
                try self.ensureSuccess(bridge, label: "啟動 bridge")

                self.loadStatus("正在啟動狀態小窗", "等待 monitor 開始回報健康狀態。")
                let monitor = self.runScript("scripts/start-monitor-tmux.sh", root: root)
                try self.ensureSuccess(monitor, label: "啟動 monitor")

                guard self.waitForMonitorHealth(timeout: 12) else {
                    throw NSError(
                        domain: "OOBridgeWidget",
                        code: 1,
                        userInfo: [
                            NSLocalizedDescriptionKey: "monitor 沒有在 12 秒內回應 /health。請檢查 logs/monitor.err。"
                        ]
                    )
                }

                self.loadWidget()
            } catch {
                self.loadError("橋接啟動失敗", error.localizedDescription)
            }
        }
    }

    private func prepareProject(root: URL) throws {
        let envURL = root.appendingPathComponent(".env")
        guard FileManager.default.fileExists(atPath: envURL.path) else {
            throw NSError(
                domain: "OOBridgeWidget",
                code: 2,
                userInfo: [
                    NSLocalizedDescriptionKey: "找不到 .env。請先複製 .env.example 成 .env，填入 Discord token 和 allowlist。"
                ]
            )
        }

        let nodeModulesURL = root.appendingPathComponent("node_modules")
        if !FileManager.default.fileExists(atPath: nodeModulesURL.path) {
            loadStatus("第一次啟動", "正在安裝 npm 依賴，這一步可能需要一點時間。")
            let install = runCommand(["npm", "install"], root: root)
            try ensureSuccess(install, label: "npm install")
        }

        let sessionFile = readEnvValue("CODEX_SESSION_FILE", root: root) ?? "state/codex-session"
        let sessionURL = projectFile(sessionFile, root: root)
        if !FileManager.default.fileExists(atPath: sessionURL.path) {
            loadStatus("建立 Codex session", "正在執行 npm run seed。")
            let seed = runCommand(["npm", "run", "seed"], root: root)
            try ensureSuccess(seed, label: "npm run seed")
        }
    }

    private func resolveProjectRoot() -> URL? {
        if let envRoot = ProcessInfo.processInfo.environment["BRIDGE_PROJECT_ROOT"], !envRoot.isEmpty {
            return URL(fileURLWithPath: envRoot)
        }

        if let resource = Bundle.main.url(forResource: "BridgeProjectRoot", withExtension: "txt"),
           let raw = try? String(contentsOf: resource, encoding: .utf8) {
            let path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !path.isEmpty {
                return URL(fileURLWithPath: path)
            }
        }

        let bundleURL = Bundle.main.bundleURL
        let distURL = bundleURL.deletingLastPathComponent()
        if distURL.lastPathComponent == "dist" {
            return distURL.deletingLastPathComponent()
        }

        return nil
    }

    private func readEnvValue(_ name: String, root: URL) -> String? {
        let envURL = root.appendingPathComponent(".env")
        guard let raw = try? String(contentsOf: envURL, encoding: .utf8) else {
            return nil
        }

        for line in raw.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed.hasPrefix("#") {
                continue
            }

            let parts = trimmed.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else {
                continue
            }

            let key = String(parts[0]).trimmingCharacters(in: .whitespacesAndNewlines)
            if key != name {
                continue
            }

            var value = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
                (value.hasPrefix("'") && value.hasSuffix("'")) {
                value.removeFirst()
                value.removeLast()
            }
            return value
        }

        return nil
    }

    private func projectFile(_ path: String, root: URL) -> URL {
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path)
        }
        return root.appendingPathComponent(path)
    }

    private func runScript(_ path: String, root: URL) -> CommandResult {
        let scriptURL = root.appendingPathComponent(path)
        return runProcess("/bin/bash", arguments: [scriptURL.path], root: root)
    }

    private func runCommand(_ arguments: [String], root: URL) -> CommandResult {
        runProcess("/usr/bin/env", arguments: arguments, root: root)
    }

    private func runProcess(_ executable: String, arguments: [String], root: URL) -> CommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = root

        var environment = ProcessInfo.processInfo.environment
        let guiPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let existingPath = environment["PATH"], !existingPath.isEmpty {
            environment["PATH"] = "\(existingPath):\(guiPath)"
        } else {
            environment["PATH"] = guiPath
        }
        environment["BRIDGE_PROJECT_ROOT"] = root.path
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(decoding: data, as: UTF8.self)
            return CommandResult(status: process.terminationStatus, output: output)
        } catch {
            return CommandResult(status: 127, output: error.localizedDescription)
        }
    }

    private func ensureSuccess(_ result: CommandResult, label: String) throws {
        if result.status == 0 {
            return
        }

        let detail = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        throw NSError(
            domain: "OOBridgeWidget",
            code: Int(result.status),
            userInfo: [
                NSLocalizedDescriptionKey: "\(label) 失敗：\(detail.isEmpty ? "沒有錯誤輸出" : detail)"
            ]
        )
    }

    private func waitForMonitorHealth(timeout: TimeInterval) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(monitorPort)/health") else {
            return false
        }

        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (try? Data(contentsOf: url)) != nil {
                return true
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    private func loadWidget() {
        guard let url = URL(string: "http://127.0.0.1:\(monitorPort)/widget") else {
            return
        }

        DispatchQueue.main.async {
            self.webView?.load(URLRequest(url: url))
        }
    }

    private func loadStatus(_ title: String, _ message: String) {
        loadHTML(title: title, message: message, isError: false)
    }

    private func loadError(_ title: String, _ message: String) {
        loadHTML(title: title, message: message, isError: true)
    }

    private func loadHTML(title: String, message: String, isError: Bool) {
        let tone = isError ? "#b53542" : "#4c3aa6"
        let badge = isError ? "!" : "CD"
        let html = """
        <!doctype html>
        <html lang="zh-Hant">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            :root { color-scheme: light; }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              background: rgba(248, 248, 250, 0.86);
              color: #20242b;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            main {
              width: min(320px, calc(100vw - 36px));
              border: 1px solid rgba(232, 230, 238, 0.94);
              border-radius: 28px;
              background: rgba(255, 255, 255, 0.78);
              box-shadow: 0 20px 48px rgba(29, 26, 46, 0.14);
              padding: 24px;
            }
            .badge {
              width: 44px;
              height: 44px;
              display: grid;
              place-items: center;
              border-radius: 999px;
              background: #e9e1ff;
              color: \(tone);
              font-weight: 800;
              margin-bottom: 18px;
            }
            h1 {
              margin: 0 0 8px;
              font-size: 22px;
              line-height: 1.2;
            }
            p {
              margin: 0;
              color: #667381;
              font-size: 14px;
              line-height: 1.55;
              white-space: pre-wrap;
              overflow-wrap: anywhere;
            }
          </style>
        </head>
        <body>
          <main>
            <div class="badge">\(escapeHTML(badge))</div>
            <h1>\(escapeHTML(title))</h1>
            <p>\(escapeHTML(message))</p>
          </main>
        </body>
        </html>
        """

        DispatchQueue.main.async {
            self.webView?.loadHTMLString(html, baseURL: nil)
        }
    }

    private func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
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
