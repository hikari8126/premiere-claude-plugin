import Cocoa
import Foundation

// ── Entry point ────────────────────────────────────────────────────────────
let app = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
let appDelegate = AppDelegate()
app.delegate = appDelegate
app.run()

// ── App Delegate ───────────────────────────────────────────────────────────
class AppDelegate: NSObject, NSApplicationDelegate {

    // MARK: State
    var statusItem: NSStatusItem!
    var bridgeTask: Process?
    var intentionalStop = false
    var restartCount    = 0
    var logLines        = [String]()
    var logWindow:    NSWindow?
    var logTextView:  NSTextView?
    var statusMenuItem: NSMenuItem!
    var autoStartItem:  NSMenuItem!

    let version          = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "2.x"
    let pluginVersion    = Bundle.main.infoDictionary?["PluginVersion"]              as? String ?? "0"
    let bridgePort       = 3030
    let updateManifest   = "https://gist.githubusercontent.com/hikari8126/8fb346e839dedd559dfc60317b1456cf/raw/version.json"

    // MARK: Lifecycle
    func applicationDidFinishLaunching(_ n: Notification) {
        setupMenuBar()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.firstRunSetup() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false  // Log window closing must NOT quit the app
    }

    func applicationWillTerminate(_ n: Notification) {
        intentionalStop = true
        bridgeTask?.terminate()
    }

    // MARK: ─── Menu Bar ────────────────────────────────────────────────────
    func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🔴"
        rebuildMenu()
    }

    func rebuildMenu() {
        let menu = NSMenu()

        let titleItem = NSMenuItem(title: "Claude Bridge  v\(version)", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)
        menu.addItem(.separator())

        statusMenuItem = NSMenuItem(title: "⏳ Đang khởi động...", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        menu.addItem(item("↺  Khởi động lại Bridge",     #selector(restartBridge), key: "r"))
        menu.addItem(item("📋  Xem Log",                  #selector(showLog),       key: "l"))
        menu.addItem(.separator())

        autoStartItem = item("🔄  Tự khởi động cùng máy", #selector(toggleAutoStart), key: "")
        autoStartItem.state = launchAgentExists() ? .on : .off
        menu.addItem(autoStartItem)

        menu.addItem(.separator())
        menu.addItem(item("🐍  Cài Whisper (Autocut STT)", #selector(installWhisper),    key: ""))
        menu.addItem(item("🎬  Cài ffmpeg (Voice & Audio)", #selector(installFfmpeg),    key: ""))
        menu.addItem(item("🔍  Kiểm tra cập nhật",         #selector(checkForUpdateMenu), key: "u"))
        menu.addItem(.separator())
        menu.addItem(item("Thoát",                         #selector(quit),               key: "q"))

        statusItem.menu = menu
    }

    func item(_ title: String, _ sel: Selector, key: String) -> NSMenuItem {
        let m = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        m.target = self
        return m
    }

    func setStatus(_ msg: String, running: Bool) {
        DispatchQueue.main.async {
            self.statusItem.button?.title = running ? "⚡" : "🔴"
            self.statusMenuItem?.title    = msg
        }
    }

    // MARK: ─── First-run Setup ─────────────────────────────────────────────
    func firstRunSetup() {
        DispatchQueue.global(qos: .userInitiated).async {
            let claudePath = self.findClaude()
            guard !claudePath.isEmpty else {
                DispatchQueue.main.async { self.promptInstallCLI() }
                return
            }
            guard self.checkAuth(claudePath: claudePath) else {
                DispatchQueue.main.async { self.promptLogin(claudePath: claudePath) }
                return
            }
            DispatchQueue.main.async { self.startBridge() }
        }
    }

    func promptInstallCLI() {
        let a = NSAlert()
        a.messageText     = "Cần cài Claude CLI"
        a.informativeText = "Claude Bridge cần Claude CLI để kết nối AI.\n\nSẽ mở Terminal và tự cài đặt — mất khoảng 2–5 phút."
        a.alertStyle      = .informational
        a.addButton(withTitle: "Cài ngay")
        a.addButton(withTitle: "Để sau")
        guard a.runModal() == .alertFirstButtonReturn else {
            setStatus("⚠️  Chưa cài Claude CLI — click ↺ để thử lại", running: false)
            return
        }
        setStatus("⏳ Đang cài Claude CLI...", running: false)

        // Write a robust install script that handles:
        //   • npm not found  → install Node.js via Homebrew first
        //   • EACCES error   → fix npm global prefix to ~/.npm-global (user-writable)
        let scriptPath = NSTemporaryDirectory() + "install_claude_cli.sh"
        let script = """
        #!/bin/bash
        set -e

        # Activate Homebrew (Apple Silicon + Intel)
        eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
        eval "$(/usr/local/bin/brew shellenv)"    2>/dev/null || true
        export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

        # Install Node.js if npm not found
        if ! command -v npm &>/dev/null; then
          echo "📦 npm chưa có — đang cài Node.js..."
          if ! command -v brew &>/dev/null; then
            echo "📦 Cài Homebrew trước..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null
          fi
          brew install node
          eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
        fi

        # Fix EACCES: redirect npm global to user-writable directory
        NPM_GLOBAL="$HOME/.npm-global"
        mkdir -p "$NPM_GLOBAL"
        npm config set prefix "$NPM_GLOBAL"
        export PATH="$NPM_GLOBAL/bin:$PATH"

        echo "📦 Đang cài Claude CLI..."
        npm install -g @anthropic-ai/claude-code

        echo ""
        echo "✅ Claude CLI đã cài xong! Bạn có thể đóng cửa sổ này."
        """

        do { try script.write(toFile: scriptPath, atomically: true, encoding: .utf8) }
        catch { log("Cannot write install script: \(error)"); return }
        sh("/bin/chmod +x '\(scriptPath)'")
        openTerminal("/bin/bash '\(scriptPath)'")

        pollUntil(check: { !self.findClaude().isEmpty }, interval: 4, timeout: 300) {
            self.firstRunSetup()
        }
    }

    func promptLogin(claudePath: String) {
        let a = NSAlert()
        a.messageText     = "Cần đăng nhập Claude.ai"
        a.informativeText = "Nhấn \"Đăng nhập\" — Terminal và trình duyệt sẽ tự mở.\n\nĐăng nhập tài khoản Claude.ai, Bridge sẽ tự khởi động sau khi xong."
        a.alertStyle      = .informational
        a.addButton(withTitle: "Đăng nhập")
        a.addButton(withTitle: "Để sau")

        guard a.runModal() == .alertFirstButtonReturn else {
            setStatus("⚠️  Chưa đăng nhập — click ↺ để thử lại", running: false)
            return
        }

        // Auto-run "claude auth login" in Terminal → browser opens → user logs in
        openTerminal("'\(claudePath)' auth login 2>&1; echo ''; echo '✅ Đăng nhập xong! Cửa sổ này có thể đóng.'")
        setStatus("⏳ Đang chờ đăng nhập Claude.ai...", running: false)

        // Poll every 3s up to 5 min — auto-start bridge when auth confirmed, no more popups
        pollUntil(
            check:     { self.checkAuth(claudePath: claudePath) },
            interval:  3,
            timeout:   300,
            then:      { self.log("Auth confirmed"); self.startBridge() },
            onTimeout: { self.setStatus("⚠️  Hết thời gian chờ — click ↺ để thử lại", running: false) }
        )
    }

    // MARK: ─── Bridge ──────────────────────────────────────────────────────
    func startBridge() {
        setStatus("⏳ Đang khởi động Bridge...", running: false)

        // ── If bridge is already healthy on port 3030, adopt it ───────────
        let health = sh("curl -s --max-time 2 http://127.0.0.1:\(bridgePort)/health 2>/dev/null")
        if health.out.contains("\"status\"") {
            log("Port \(bridgePort) already serving — adopting existing bridge")
            restartCount = 0
            intentionalStop = false
            setStatus("✅ Bridge đang chạy  —  :\(bridgePort)", running: true)
            return
        }

        // ── Kill any zombie holding port 3030 ─────────────────────────────
        let kill = sh("lsof -ti :\(bridgePort) 2>/dev/null | xargs kill -9 2>/dev/null; echo ok")
        log("Cleared port \(bridgePort): \(kill.out.trimmingCharacters(in: .whitespacesAndNewlines))")
        Thread.sleep(forTimeInterval: 0.4)

        guard let (nodePath, serverDir) = findNodeAndServer() else {
            setStatus("❌ Node.js chưa cài — tải tại nodejs.org", running: false)
            log("ERROR: Node.js not found. Install from https://nodejs.org")
            return
        }

        let task    = Process()
        let pipe    = Pipe()

        task.executableURL       = URL(fileURLWithPath: nodePath)
        task.arguments           = ["server.js"]
        task.currentDirectoryURL = URL(fileURLWithPath: serverDir)
        task.environment         = buildEnv()
        task.standardOutput      = pipe
        task.standardError       = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            self?.log(line.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        task.terminationHandler = { [weak self] p in
            guard let self else { return }
            self.log("Bridge stopped (exit \(p.terminationStatus))")
            DispatchQueue.main.async {
                self.bridgeTask = nil
                self.setStatus("❌ Bridge dừng", running: false)
                guard !self.intentionalStop else { return }
                self.restartCount += 1
                let delay = min(Double(self.restartCount) * 2.0, 30.0)
                self.log("Auto-restart sau \(Int(delay))s (lần \(self.restartCount))...")
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    self.startBridge()
                }
            }
        }

        do {
            try task.run()
            bridgeTask    = task
            intentionalStop = false

            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                guard task.isRunning else { return }
                self.restartCount = 0
                self.setStatus("✅ Bridge đang chạy  —  :\(self.bridgePort)", running: true)
                self.log("Bridge started (PID \(task.processIdentifier), mode: \(self.detectMode()))")
                // Check for updates silently — only shows alert if newer version exists
                DispatchQueue.global().asyncAfter(deadline: .now() + 3) { self.checkForUpdates(silent: true) }
            }
        } catch {
            setStatus("❌ Lỗi khởi động: \(error.localizedDescription)", running: false)
            log("ERROR starting bridge: \(error)")
        }
    }

    func stopBridge(intentional: Bool = true) {
        intentionalStop = intentional
        bridgeTask?.interrupt()
        bridgeTask?.terminate()
        bridgeTask = nil
    }

    @objc func restartBridge() {
        log("Restart requested by user")
        stopBridge(intentional: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            self.intentionalStop = false
            self.firstRunSetup()   // re-check auth before starting
        }
    }

    // MARK: ─── Log Window ──────────────────────────────────────────────────
    func log(_ line: String) {
        guard !line.isEmpty else { return }
        let ts    = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        let entry = "[\(ts)]  \(line)"
        DispatchQueue.main.async {
            self.logLines.append(entry)
            if self.logLines.count > 1000 { self.logLines.removeFirst(200) }
            if let tv = self.logTextView {
                tv.string = self.logLines.joined(separator: "\n")
                tv.scrollToEndOfDocument(nil)
            }
        }
        print(entry)
    }

    @objc func showLog() {
        if logWindow == nil {
            let win = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 680, height: 440),
                styleMask:   [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered, defer: false)
            win.title = "Claude Bridge — Log"
            win.center()

            let sv = NSScrollView(frame: win.contentView!.bounds)
            sv.autoresizingMask     = [.width, .height]
            sv.hasVerticalScroller  = true

            let tv = NSTextView(frame: sv.bounds)
            tv.isEditable       = false
            tv.font             = .monospacedSystemFont(ofSize: 11, weight: .regular)
            tv.backgroundColor  = NSColor(white: 0.09, alpha: 1)
            tv.textColor        = NSColor(white: 0.88, alpha: 1)
            tv.string           = logLines.joined(separator: "\n")
            tv.scrollToEndOfDocument(nil)

            sv.documentView = tv
            win.contentView?.addSubview(sv)
            logWindow   = win
            logTextView = tv

            // Close callback
            NotificationCenter.default.addObserver(
                self, selector: #selector(logWindowClosed),
                name: NSWindow.willCloseNotification, object: win)
        }
        logWindow?.makeKeyAndOrderFront(nil)
        // Switch to .regular so the window gets keyboard focus,
        // then restore .accessory when it closes — prevents auto-quit on close
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func logWindowClosed() {
        logWindow   = nil
        logTextView = nil
        // CRITICAL: restore menubar-only mode — otherwise macOS quits the app
        // when it sees no remaining windows in .regular mode
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: ─── Auto-start (LaunchAgent) ────────────────────────────────────
    @objc func toggleAutoStart() {
        if launchAgentExists() {
            removeLaunchAgent()
            autoStartItem?.state = .off
            log("Auto-start disabled")
        } else {
            installLaunchAgent()
            autoStartItem?.state = .on
            log("Auto-start enabled")
        }
    }

    var launchAgentPath: String {
        NSHomeDirectory() + "/Library/LaunchAgents/com.claudeai.bridge.plist"
    }
    func launchAgentExists() -> Bool {
        FileManager.default.fileExists(atPath: launchAgentPath)
    }

    func installLaunchAgent() {
        let appExe = Bundle.main.bundlePath + "/Contents/MacOS/Claude Bridge"
        let plist: NSDictionary = [
            "Label":              "com.claudeai.bridge",
            "ProgramArguments":   [appExe],
            "RunAtLoad":          true,
            "KeepAlive":          false,
            "StandardOutPath":    NSHomeDirectory() + "/Library/Logs/claude-bridge.log",
            "StandardErrorPath":  NSHomeDirectory() + "/Library/Logs/claude-bridge.log",
        ]
        let dir = (launchAgentPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        plist.write(toFile: launchAgentPath, atomically: true)
        // Do NOT call launchctl load here — that would start a second instance immediately.
        // LaunchAgents in ~/Library/LaunchAgents/ are picked up automatically on next login.
        log("LaunchAgent installed — will auto-start on next login")
    }

    func removeLaunchAgent() {
        let t = Process()
        t.launchPath = "/bin/launchctl"
        t.arguments  = ["unload", launchAgentPath]
        try? t.run(); t.waitUntilExit()
        try? FileManager.default.removeItem(atPath: launchAgentPath)
    }

    // MARK: ─── ffmpeg ────────────────────────────────────────────────────────
    @objc func installFfmpeg() {
        let a = NSAlert()
        a.messageText     = "Cài ffmpeg cho Voice Gen"
        a.informativeText = "ffmpeg được dùng để xử lý audio trong tính năng Voice Clone & Voice Gen.\n\nSẽ mở Terminal cài tự động (cần Homebrew + ~300MB, vài phút)."
        a.addButton(withTitle: "Cài ngay")
        a.addButton(withTitle: "Huỷ")
        guard a.runModal() == .alertFirstButtonReturn else { return }

        let cmd = """
        export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
        eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || true
        eval "$(/usr/local/bin/brew shellenv 2>/dev/null)"    || true

        if ! command -v brew &>/dev/null; then
          echo "🍺 Homebrew chưa có — đang cài..."
          /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
          eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || eval "$(/usr/local/bin/brew shellenv 2>/dev/null)"
        fi

        if ! command -v brew &>/dev/null; then
          echo "❌ Cài Homebrew thất bại. Vui lòng cài thủ công tại https://brew.sh rồi chạy lại."
          exit 1
        fi

        echo "🎬 Đang cài ffmpeg..."
        brew install ffmpeg 2>&1
        echo ""
        echo "✅ ffmpeg đã cài xong!"
        ffmpeg -version | head -1
        """
        openTerminal(cmd)
    }

    // MARK: ─── Whisper ─────────────────────────────────────────────────────
    @objc func installWhisper() {
        let a = NSAlert()
        a.messageText     = "Cài Whisper cho Autocut"
        a.informativeText = "Whisper là model AI nhận diện giọng nói, dùng cho tính năng Autocut.\n\nSẽ mở Terminal cài tự động (cần Homebrew + Python + ~500MB, vài phút)."
        a.addButton(withTitle: "Cài ngay")
        a.addButton(withTitle: "Huỷ")
        guard a.runModal() == .alertFirstButtonReturn else { return }

        let cmd = """
        export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
        eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || true
        eval "$(/usr/local/bin/brew shellenv 2>/dev/null)"    || true

        if ! command -v brew &>/dev/null; then
          echo "🍺 Homebrew chưa có — đang cài..."
          /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
          eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || eval "$(/usr/local/bin/brew shellenv 2>/dev/null)"
        fi

        if ! command -v brew &>/dev/null; then
          echo "❌ Cài Homebrew thất bại. Vui lòng cài thủ công tại https://brew.sh rồi chạy lại."
          exit 1
        fi

        if ! command -v pip3 &>/dev/null; then
          echo "🐍 pip3 chưa có — đang cài Python..."
          brew install python3 2>&1
        fi

        echo "🐍 Đang cài Whisper..."
        pip3 install -U openai-whisper 2>&1 || pip3 install -U openai-whisper --break-system-packages 2>&1
        echo ""
        echo "✅ Whisper đã cài xong!"
        which whisper
        """
        openTerminal(cmd)
    }

    // MARK: ─── Auto-update ────────────────────────────────────────────────
    @objc func checkForUpdateMenu() { checkForUpdates(silent: false) }

    func checkForUpdates(silent: Bool = true) {
        let bustedURL = updateManifest + "?t=\(Int(Date().timeIntervalSince1970))"
        guard let url = URL(string: bustedURL) else { return }
        log("Checking for updates (Bridge v\(version), Plugin v\(pluginVersion))...")
        URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            guard let self else { return }
            guard let data, error == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                self.log("Update check failed: \(error?.localizedDescription ?? "bad response")")
                if !silent { DispatchQueue.main.async { self.showNoUpdateAlert() } }
                return
            }
            let latestBridge = json["version"]           as? String ?? ""
            let bridgePage   = json["url"]               as? String ?? ""
            let bridgeDL     = json["downloadUrl"]       as? String ?? ""
            let notes        = json["notes"]             as? String ?? ""
            let latestPlugin = json["pluginVersion"]     as? String ?? ""
            let pluginDL     = json["pluginDownloadUrl"] as? String ?? ""

            let bridgeNewer = !latestBridge.isEmpty && self.isNewer(latestBridge, than: self.version)
            let pluginNewer = !latestPlugin.isEmpty && !pluginDL.isEmpty && self.isNewer(latestPlugin, than: self.pluginVersion)

            self.log("Bridge: v\(self.version) → v\(latestBridge) (\(bridgeNewer ? "UPDATE" : "up-to-date"))")
            self.log("Plugin: v\(self.pluginVersion) → v\(latestPlugin) (\(pluginNewer ? "UPDATE" : "up-to-date"))")

            if bridgeNewer || pluginNewer {
                DispatchQueue.main.async {
                    self.showUpdateResults(
                        bridgeNewer: bridgeNewer, latestBridge: latestBridge,
                        bridgePage: bridgePage, bridgeDL: bridgeDL,
                        pluginNewer: pluginNewer, latestPlugin: latestPlugin,
                        pluginDL: pluginDL, notes: notes
                    )
                }
            } else if !silent {
                DispatchQueue.main.async { self.showNoUpdateAlert() }
            }
        }.resume()
    }

    func isNewer(_ v1: String, than v2: String) -> Bool {
        let parse: (String) -> [Int] = { $0.split(separator: ".").compactMap { Int($0) } }
        let a = parse(v1), b = parse(v2)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    func showUpdateResults(bridgeNewer: Bool, latestBridge: String,
                           bridgePage: String,  bridgeDL: String,
                           pluginNewer: Bool,   latestPlugin: String,
                           pluginDL: String,    notes: String) {
        let a = NSAlert()
        a.alertStyle = .informational

        var titleParts = [String]()
        if bridgeNewer { titleParts.append("Bridge v\(latestBridge)") }
        if pluginNewer { titleParts.append("Plugin v\(latestPlugin)") }
        a.messageText = "⬆️  Bản cập nhật: \(titleParts.joined(separator: " + "))"

        var infoLines = [String]()
        if !notes.isEmpty { infoLines.append(notes) }
        if bridgeNewer { infoLines.append("• Bridge: tự động tải + cài đặt, app tự khởi động lại") }
        if pluginNewer { infoLines.append("• Plugin: tải .ccx → Creative Cloud mở → click Install") }
        a.informativeText = infoLines.joined(separator: "\n")

        if bridgeNewer && pluginNewer {
            a.addButton(withTitle: "Cài Bridge")
            a.addButton(withTitle: "Cài Plugin")
        } else if bridgeNewer {
            a.addButton(withTitle: "Cài ngay")
        } else {
            a.addButton(withTitle: "Cài Plugin")
        }
        a.addButton(withTitle: "Để sau")

        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let result = a.runModal()
        NSApp.setActivationPolicy(.accessory)

        if bridgeNewer && pluginNewer {
            if result == .alertFirstButtonReturn  { performUpdate(downloadURL: bridgeDL, newVersion: latestBridge) }
            else if result == .alertSecondButtonReturn { performPluginUpdate(downloadURL: pluginDL, version: latestPlugin) }
        } else if bridgeNewer {
            if result == .alertFirstButtonReturn  { performUpdate(downloadURL: bridgeDL, newVersion: latestBridge) }
        } else {
            if result == .alertFirstButtonReturn  { performPluginUpdate(downloadURL: pluginDL, version: latestPlugin) }
        }
    }

    func performPluginUpdate(downloadURL: String, version: String) {
        guard let url = URL(string: downloadURL) else {
            log("Plugin update: invalid URL — \(downloadURL)"); return
        }
        let isRunning = bridgeTask?.isRunning ?? false
        log("Downloading Plugin v\(version) from: \(downloadURL)")
        setStatus("⬇️ Đang tải Plugin v\(version)...", running: isRunning)

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForResource = 120
        URLSession(configuration: cfg).downloadTask(with: url) { [weak self] tempURL, _, error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async {
                    self.log("Plugin download failed: \(error.localizedDescription)")
                    self.setStatus(isRunning ? "✅ Bridge đang chạy  —  :\(self.bridgePort)" : "❌ Bridge dừng",
                                   running: isRunning)
                }
                return
            }
            guard let tempURL else { return }
            let ccxName = "claude-ai-assistant-v\(version).ccx"
            let ccxURL  = URL(fileURLWithPath: (NSTemporaryDirectory() as NSString).appendingPathComponent(ccxName))
            try? FileManager.default.removeItem(at: ccxURL)
            try? FileManager.default.moveItem(at: tempURL, to: ccxURL)

            DispatchQueue.main.async {
                self.log("Plugin downloaded → \(ccxURL.path)")
                self.setStatus(isRunning ? "✅ Bridge đang chạy  —  :\(self.bridgePort)" : "❌ Bridge dừng",
                               running: isRunning)
                NSWorkspace.shared.open(ccxURL)

                let a = NSAlert()
                a.messageText     = "🎉 Plugin v\(version) đã tải về"
                a.informativeText = "Creative Cloud đang mở để cài đặt.\n\n1. Click \"Install\" trong cửa sổ Creative Cloud\n2. Mở Premiere Pro → plugin sẽ được cập nhật tự động"
                a.alertStyle      = .informational
                a.addButton(withTitle: "OK")
                NSApp.setActivationPolicy(.regular)
                NSApp.activate(ignoringOtherApps: true)
                a.runModal()
                NSApp.setActivationPolicy(.accessory)
            }
        }.resume()
    }

    // MARK: ─── Self-Update: download → install → relaunch ────────────────────

    func performUpdate(downloadURL: String, newVersion: String) {
        guard let url = URL(string: downloadURL) else {
            log("Update: invalid download URL — \(downloadURL)"); return
        }
        log("Downloading update v\(newVersion) from: \(downloadURL)")
        let isRunning = bridgeTask?.isRunning ?? false
        setStatus("⬇️ Đang tải v\(newVersion)...", running: isRunning)

        let cfg  = URLSessionConfiguration.default
        cfg.timeoutIntervalForResource = 300
        let task = URLSession(configuration: cfg).downloadTask(with: url) { [weak self] tempURL, _, error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async {
                    self.log("Download failed: \(error.localizedDescription)")
                    self.setStatus("❌ Tải thất bại — thử lại sau", running: false)
                }
                return
            }
            guard let tempURL else {
                DispatchQueue.main.async { self.setStatus("❌ Lỗi tải về", running: false) }
                return
            }
            DispatchQueue.main.async {
                self.log("Download complete → installing v\(newVersion)...")
                self.installUpdate(zipURL: tempURL, newVersion: newVersion)
            }
        }
        task.resume()
    }

    func installUpdate(zipURL: URL, newVersion: String) {
        let fm     = FileManager.default
        let tmpDir = NSTemporaryDirectory() + "cb_update_\(newVersion)"

        try? fm.removeItem(atPath: tmpDir)
        guard (try? fm.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)) != nil else {
            log("Install failed: cannot create temp dir"); return
        }

        let zipPath = tmpDir + "/update.zip"
        do { try fm.moveItem(at: zipURL, to: URL(fileURLWithPath: zipPath)) }
        catch { log("Install failed — move zip: \(error)"); return }

        setStatus("📦 Đang giải nén...", running: false)
        log("Unzipping to \(tmpDir)...")
        let unzip = shTimeout("unzip -q '\(zipPath)' -d '\(tmpDir)'",
                              env: buildEnv(), timeout: 120)
        if unzip.status != 0 {
            log("Unzip failed (exit \(unzip.status)): \(unzip.out)")
            setStatus("❌ Giải nén thất bại", running: false)
            return
        }

        // Find Claude Bridge.app anywhere in extracted tree
        let find      = sh("find '\(tmpDir)' -maxdepth 4 -name 'Claude Bridge.app' -type d | head -1")
        let newAppPath = find.out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !newAppPath.isEmpty else {
            log("Install failed: Claude Bridge.app not found in zip"); return
        }

        log("New app at: \(newAppPath)")
        setStatus("🔄 Đang cài đặt...", running: false)

        stopBridge(intentional: true)
        Thread.sleep(forTimeInterval: 0.5)

        relaunch(replacingWith: newAppPath)
    }

    func relaunch(replacingWith newAppPath: String) {
        let currentPath = Bundle.main.bundlePath
        let scriptPath  = NSTemporaryDirectory() + "cb_relaunch_\(Int(Date().timeIntervalSince1970)).sh"

        // Shell script: wait for this process to exit, swap bundles, relaunch
        let script = """
        #!/bin/bash
        sleep 2
        rm   -rf '\(currentPath)'
        mv   '\(newAppPath)' '\(currentPath)'
        xattr -dr com.apple.quarantine '\(currentPath)' 2>/dev/null || true
        sleep 0.5
        open '\(currentPath)'
        rm -- "$0"
        """

        do { try script.write(toFile: scriptPath, atomically: true, encoding: .utf8) }
        catch { log("Relaunch script write failed: \(error)"); return }

        sh("/bin/chmod +x '\(scriptPath)'")

        // Launch detached — do NOT waitUntilExit
        let launcher = Process()
        launcher.launchPath      = "/bin/bash"
        launcher.arguments       = [scriptPath]
        launcher.standardOutput  = FileHandle.nullDevice
        launcher.standardError   = FileHandle.nullDevice
        try? launcher.run()

        log("Relaunch script detached — quitting current instance...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { NSApp.terminate(nil) }
    }

    func showNoUpdateAlert() {
        let a = NSAlert()
        a.messageText     = "✅  Đang dùng bản mới nhất"
        a.informativeText = "Bridge v\(version) + Plugin v\(pluginVersion) đều là bản mới nhất."
        a.alertStyle      = .informational
        a.addButton(withTitle: "OK")
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: ─── Quit ────────────────────────────────────────────────────────
    @objc func quit() {
        stopBridge(intentional: true)
        NSApp.terminate(nil)
    }

    // MARK: ─── Helpers ─────────────────────────────────────────────────────
    func findClaude() -> String {
        let candidates = [
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            NSHomeDirectory() + "/.npm-global/bin/claude",
            NSHomeDirectory() + "/.nvm/versions/node/current/bin/claude",
            NSHomeDirectory() + "/Library/pnpm/claude",
        ]
        if let found = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) { return found }
        let r = sh("/usr/bin/which claude")
        return r.status == 0 ? r.out.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }

    func findNodeAndServer() -> (nodePath: String, serverDir: String)? {
        // Find node binary
        let nodeCandidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            NSHomeDirectory() + "/.nvm/versions/node/current/bin/node",
            "/usr/bin/node",
        ]
        var nodePath = nodeCandidates.first(where: { FileManager.default.fileExists(atPath: $0) }) ?? ""
        if nodePath.isEmpty {
            let r = sh("/usr/bin/which node")
            if r.status == 0 { nodePath = r.out.trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        guard !nodePath.isEmpty, FileManager.default.fileExists(atPath: nodePath) else { return nil }

        // Find server.js inside app bundle
        guard let rp = Bundle.main.resourcePath else { return nil }
        let serverDir = rp + "/server"
        guard FileManager.default.fileExists(atPath: serverDir + "/server.js") else { return nil }
        return (nodePath, serverDir)
    }

    func checkAuth(claudePath: String) -> Bool {
        // Claude Code v2.x: 'claude auth status' returns JSON {"loggedIn": true/false, ...}
        let r   = shTimeout("'\(claudePath)' auth status 2>&1", env: buildEnv(), timeout: 10)
        let out = r.out
        let low = out.lowercased()

        log("checkAuth: exit=\(r.status) → \(out.prefix(160).trimmingCharacters(in: .whitespacesAndNewlines))")

        // ── Positive signals ───────────────────────────────────────────────
        // JSON (case-insensitive key, e.g. "loggedIn": true / "loggedin":true)
        if low.contains("\"loggedin\": true") || low.contains("\"loggedin\":true") { return true }
        // Text format ("Logged in as ...")
        if low.contains("logged in") && !low.contains("not logged in") { return true }

        // ── Definitive NOT-logged-in signals ───────────────────────────────
        // NOTE: Do NOT blacklist "oauth" / "sign in" — they appear in VALID auth output
        //       e.g. {"authMethod":"claude.ai","oauthSessionExpiry":"..."}
        let notAuth = ["not logged in", "not authenticated",
                       "\"loggedin\": false", "\"loggedin\":false",
                       "login required", "please log in", "please authenticate"]
        if notAuth.contains(where: { low.contains($0) }) { return false }

        // Command exited 0 with no known error → treat as logged in
        return r.status == 0
    }

    func detectMode() -> String {
        let envFile = Bundle.main.resourcePath.map { $0 + "/server/.env" } ?? ""
        if let contents = try? String(contentsOfFile: envFile), contents.contains("ANTHROPIC_API_KEY=sk-") {
            return "api-key"
        }
        // Check sibling .env
        let siblingEnv = (Bundle.main.bundlePath as NSString).deletingLastPathComponent + "/.env"
        if let contents = try? String(contentsOfFile: siblingEnv), contents.contains("ANTHROPIC_API_KEY=sk-") {
            return "api-key"
        }
        return "claude-cli"
    }

    func buildEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let paths = [
            "/opt/homebrew/bin", "/opt/homebrew/sbin",
            "/usr/local/bin",    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
            NSHomeDirectory() + "/.npm-global/bin",
            NSHomeDirectory() + "/.nvm/versions/node/current/bin",
        ].joined(separator: ":")
        env["PATH"] = paths + ":" + (env["PATH"] ?? "")
        env["HOME"] = NSHomeDirectory()
        env["USER"] = NSUserName()

        // Load .env files: bundle first, then sibling (overrides)
        for envFilePath in [
            Bundle.main.resourcePath.map { $0 + "/server/.env" } ?? "",
            (Bundle.main.bundlePath as NSString).deletingLastPathComponent + "/.env",
            NSHomeDirectory() + "/Library/Application Support/ClaudeBridge/.env",
        ] {
            guard let lines = try? String(contentsOfFile: envFilePath, encoding: .utf8) else { continue }
            for line in lines.components(separatedBy: "\n") {
                let t = line.trimmingCharacters(in: .whitespaces)
                guard !t.hasPrefix("#"), !t.isEmpty else { continue }
                let parts = t.split(separator: "=", maxSplits: 1).map(String.init)
                if parts.count == 2 { env[parts[0]] = parts[1] }
            }
        }
        return env
    }

    func openTerminal(_ cmd: String) {
        let escaped = cmd
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let src = "tell application \"Terminal\" to activate\ntell application \"Terminal\" to do script \"\(escaped)\""
        if let s = NSAppleScript(source: src) { s.executeAndReturnError(nil) }
    }

    func pollUntil(check: @escaping () -> Bool, interval: TimeInterval, timeout: TimeInterval,
                   then: @escaping () -> Void, onTimeout: (() -> Void)? = nil) {
        var spent = 0.0
        func step() {
            DispatchQueue.global().async {
                if check() { DispatchQueue.main.async { then() }; return }
                spent += interval
                guard spent < timeout else {
                    if let cb = onTimeout { DispatchQueue.main.async { cb() } }
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + interval) { step() }
            }
        }
        step()
    }

    @discardableResult
    func sh(_ cmd: String) -> (out: String, status: Int32) {
        let p = Process()
        p.launchPath = "/bin/bash"
        p.arguments  = ["-c", cmd]
        p.environment = ["PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"]
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
        try? p.run(); p.waitUntilExit()
        return (String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "", p.terminationStatus)
    }

    func shTimeout(_ cmd: String, env: [String: String], timeout: TimeInterval) -> (out: String, status: Int32) {
        let p = Process()
        p.launchPath  = "/bin/bash"
        p.arguments   = ["-c", cmd]
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
        var out = ""; var status = Int32(-1)
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            try? p.run(); p.waitUntilExit()
            out    = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            status = p.terminationStatus
            sem.signal()
        }
        if sem.wait(timeout: .now() + timeout) == .timedOut { p.terminate() }
        return (out, status)
    }
}
