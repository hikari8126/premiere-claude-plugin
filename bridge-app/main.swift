import Cocoa
import Foundation
import Carbon.HIToolbox   // RegisterEventHotKey + kVK/modifier constants (global hotkeys)

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
    var updateMenuItem: NSMenuItem?          // shown when update available
    var updateTimer: Timer?                  // periodic auto-check so the notice appears on its own
    var pendingBridgeDL  = ""
    var pendingBridgeVer = ""

    let version          = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "2.x"
    let bridgePort       = 3030
    let updateManifest   = "https://gist.githubusercontent.com/hikari8126/8fb346e839dedd559dfc60317b1456cf/raw/version.json"

    // MARK: Lifecycle
    func applicationDidFinishLaunching(_ n: Notification) {
        setupMenuBar()
        UnnestHotkeys.shared.start()   // register global un-nest hotkeys + watch config
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.firstRunSetup() }
        // Auto-check for updates so the "⬆️ Có bản cập nhật" item appears on its own.
        // Runs independently of whether the bundled bridge process managed to start.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { self.checkForUpdates() }
        updateTimer = Timer.scheduledTimer(withTimeInterval: 1800, repeats: true) { [weak self] _ in
            self?.checkForUpdates()
        }
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

        // ── Update notification (hidden until update found) ───────────────
        let updItem = NSMenuItem(title: "⬆️  Có bản cập nhật", action: #selector(installAvailableUpdate), keyEquivalent: "")
        updItem.target = self
        updItem.isHidden = true
        menu.addItem(updItem)
        updateMenuItem = updItem

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
        menu.addItem(item("🐍  Cài Whisper (Autocut STT)",  #selector(installWhisper),     key: ""))
        menu.addItem(item("🎬  Cài ffmpeg (Voice & Audio)",  #selector(installFfmpeg),      key: ""))
        menu.addItem(.separator())
        menu.addItem(item("Thoát",                            #selector(quit),               key: "q"))

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
            // Check Whisper before starting bridge (required for Autocut)
            if self.findWhisper().isEmpty {
                DispatchQueue.main.async { self.promptInstallWhisperBlocking() }
            } else {
                DispatchQueue.main.async { self.startBridge() }
            }
        }
    }

    // Blocking prompt for Whisper during first-run setup.
    // Unlike checkWhisperOnce (fire-and-forget), this pauses the startup flow.
    func promptInstallWhisperBlocking() {
        let a = NSAlert()
        a.messageText    = "Cài Whisper cho Autocut?"
        a.informativeText =
            "Whisper (AI nhận diện giọng nói) cần thiết để align voice trong Autocut.\n\n" +
            "Cài ngay (~500MB, 2–5 phút) hoặc bỏ qua và cài sau."
        a.alertStyle = .informational
        a.addButton(withTitle: "Cài ngay")
        a.addButton(withTitle: "Bỏ qua")
        if a.runModal() == .alertFirstButtonReturn {
            installWhisper()
            // Poll until whisper is installed then start bridge
            pollUntil(check: { !self.findWhisper().isEmpty }, interval: 5, timeout: 600) {
                self.startBridge()
            }
        } else {
            startBridge()
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
            updateStatusWithBridgeVersion()
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
                self.updateStatusWithBridgeVersion()
                self.log("Bridge started (PID \(task.processIdentifier), mode: \(self.detectMode()))")
                // Check for a newer Bridge app — surfaces the "⬆️ Có bản cập nhật" item if found
                DispatchQueue.global().asyncAfter(deadline: .now() + 3) { self.checkForUpdates() }
                // Prompt Whisper install if not found (non-blocking, after bridge is stable)
                DispatchQueue.global().asyncAfter(deadline: .now() + 5) { self.checkWhisperOnce() }
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
        setStatus("⏳ Đang khởi động lại Bridge...", running: false)
        intentionalStop = true
        // Kill managed process
        bridgeTask?.interrupt()
        bridgeTask?.terminate()
        bridgeTask = nil
        // Also force-kill anything on port — handles externally-started bridges
        sh("lsof -ti :\(bridgePort) 2>/dev/null | xargs kill -9 2>/dev/null")
        Thread.sleep(forTimeInterval: 0.5)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            self.intentionalStop = false
            self.startBridge()  // skip auth re-check on explicit restart
        }
    }

    // Fetch bridge version from /health and update status label
    func updateStatusWithBridgeVersion() {
        DispatchQueue.global().async {
            let h = self.sh("curl -s --max-time 3 http://127.0.0.1:\(self.bridgePort)/health 2>/dev/null")
            var label = "✅ Bridge  —  :\(self.bridgePort)"
            if let data = h.out.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let ver  = json["version"] as? String {
                label = "✅ Bridge v\(ver)  —  :\(self.bridgePort)"
            }
            DispatchQueue.main.async { self.setStatus(label, running: true) }
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
    // Mirror the Node bridge's findWhisperBin() exactly so that whenever the bridge
    // can run whisper, this app also detects it — otherwise the install prompt kept
    // reappearing for users whose whisper lives in a path the app didn't scan
    // (system pip / --break-system-packages → /Library/Python, or user-site pip).
    func findWhisper() -> String {
        let fm = FileManager.default
        // 1) PATH
        let which = sh("which whisper 2>/dev/null")
        let p = which.out.trimmingCharacters(in: .whitespacesAndNewlines)
        if !p.isEmpty && fm.fileExists(atPath: p) { return p }

        let versions = ["3.14","3.13","3.12","3.11","3.10","3.9"]
        // 2) python.org framework installs
        for v in versions {
            let c = "/Library/Frameworks/Python.framework/Versions/\(v)/bin/whisper"
            if fm.fileExists(atPath: c) { return c }
        }
        // 3) system Python / Command Line Tools (pip3 --break-system-packages lands here)
        for v in versions {
            let c = "/Library/Python/\(v)/bin/whisper"
            if fm.fileExists(atPath: c) { return c }
        }
        // 4) user-site pip installs (~/Library/Python/3.x/bin)
        for v in versions {
            let c = "\(NSHomeDirectory())/Library/Python/\(v)/bin/whisper"
            if fm.fileExists(atPath: c) { return c }
        }
        // 5) Homebrew / local
        for c in ["/opt/homebrew/bin/whisper", "/usr/local/bin/whisper",
                  "\(NSHomeDirectory())/.local/bin/whisper"] {
            if fm.fileExists(atPath: c) { return c }
        }
        return ""
    }

    // Called once after bridge starts — shows a one-time prompt if Whisper is missing.
    func checkWhisperOnce() {
        guard findWhisper().isEmpty else { return } // already installed
        let key = "whisper_prompt_shown"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        DispatchQueue.main.async {
            let a = NSAlert()
            a.messageText    = "Cài Whisper cho Autocut?"
            a.informativeText =
                "Whisper là AI nhận diện giọng nói — cần thiết để align voice với script trong Autocut.\n\n" +
                "Cài ngay (~500MB, vài phút) hoặc dùng menu 🐍 Cài Whisper sau."
            a.alertStyle = .informational
            a.addButton(withTitle: "Cài ngay")
            a.addButton(withTitle: "Để sau")
            if a.runModal() == .alertFirstButtonReturn {
                self.installWhisper()
            }
        }
    }

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
    @objc func installAvailableUpdate() {
        guard !pendingBridgeDL.isEmpty else { return }
        // No confirmation dialog — clicking the update item installs straight away.
        // Progress is shown in the menu status line ("⬇️ Đang tải...").
        performUpdate(downloadURL: pendingBridgeDL, newVersion: pendingBridgeVer)
    }

    // Bridge app only manages Bridge-app updates now — plugin updates are handled by
    // the plugin's own in-app updater. Runs silently on a timer; the
    // "⬆️ Có bản cập nhật" menu item appears on its own when a newer Bridge is out.
    func checkForUpdates() {
        let bustedURL = updateManifest + "?t=\(Int(Date().timeIntervalSince1970))"
        guard let url = URL(string: bustedURL) else { return }
        log("Checking for Bridge updates (v\(version))...")
        URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            guard let self else { return }
            guard let data, error == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                self.log("Update check failed: \(error?.localizedDescription ?? "bad response")")
                return
            }
            let latestBridge = json["version"]     as? String ?? ""
            let bridgeDL     = json["downloadUrl"]  as? String ?? ""

            let bridgeNewer = !latestBridge.isEmpty && self.isNewer(latestBridge, than: self.version)
            self.log("Bridge: v\(self.version) → v\(latestBridge) (\(bridgeNewer ? "UPDATE" : "up-to-date"))")

            DispatchQueue.main.async {
                if bridgeNewer {
                    self.pendingBridgeDL  = bridgeDL
                    self.pendingBridgeVer = latestBridge
                    self.updateMenuItem?.title    = "⬆️  Bridge v\(latestBridge) — Cập nhật"
                    self.updateMenuItem?.isHidden = false
                    self.log("Bridge update available: v\(latestBridge)")
                } else {
                    self.updateMenuItem?.isHidden = true
                }
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

        // Shell script: wait for this process to exit, swap bundles atomically-ish,
        // dọn sạch bản cũ + bản trùng, refresh LaunchServices, rồi relaunch.
        // Mục tiêu: KHÔNG bao giờ để lại bản cũ khiến lần mở sau chạy nhầm.
        let script = """
        #!/bin/bash
        # Log để chẩn đoán update (xem ~/Library/Logs/claude-bridge-update.log)
        exec >> "$HOME/Library/Logs/claude-bridge-update.log" 2>&1
        echo "=== $(date) relaunch: \(currentPath) ==="
        sleep 2

        CUR='\(currentPath)'
        NEW='\(newAppPath)'
        BAK="${CUR}.bak"

        # Kill instance cũ còn chạy (tránh 'open' bám vào tiến trình cũ)
        pkill -f "${CUR}/Contents/MacOS/" 2>/dev/null || true
        sleep 0.5

        # Backup bản cũ rồi đưa bản mới vào; nếu mv fail → khôi phục (không bao giờ mất app)
        rm -rf "$BAK" 2>/dev/null || true
        [ -d "$CUR" ] && mv "$CUR" "$BAK" 2>/dev/null || true
        if mv "$NEW" "$CUR" 2>/dev/null; then
          rm -rf "$BAK" 2>/dev/null || true
          echo "moved new app into place OK"
        else
          echo "mv FAILED — restoring backup"
          [ -d "$BAK" ] && mv "$BAK" "$CUR" 2>/dev/null || true
        fi

        # Dọn bản trùng ở nơi khác để macOS không mở nhầm bản cũ
        for alt in "$HOME/Downloads/Claude Bridge.app" "$HOME/Desktop/Claude Bridge.app"; do
          [ "$alt" != "$CUR" ] && [ -d "$alt" ] && rm -rf "$alt" && echo "removed dup: $alt"
        done
        if [ "$CUR" = "/Applications/Claude Bridge.app" ]; then
          rm -rf "$HOME/Applications/Claude Bridge.app" 2>/dev/null || true
        fi

        xattr -dr com.apple.quarantine "$CUR" 2>/dev/null || true
        # Cập nhật đăng ký LaunchServices → Spotlight/Finder trỏ đúng bản mới
        LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
        [ -x "$LSREG" ] && "$LSREG" -f "$CUR" 2>/dev/null || true

        sleep 0.5
        open "$CUR" || open -a "$CUR"
        echo "relaunched"
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

// ── UN-NEST global hotkeys (Carbon RegisterEventHotKey) ──────────────────────
// Owns 3 OS-global hotkeys (one per un-nest mode). On press → POST the mode to the
// local bridge; the UXP plugin polls /unnest/poll and runs on the current
// selection. Combos come from ~/Library/Application Support/ClaudeBridge/hotkeys.json
// (written by the plugin, OUTSIDE the app bundle) and are re-registered when it changes.
// Carbon hotkeys do NOT need Accessibility — only the un-nest keystrokes (osascript) do.

// JS KeyboardEvent.code → macOS virtual keycode (layout-independent).
let kVKByCode: [String: UInt32] = [
  "Digit0": 0x1D, "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15,
  "Digit5": 0x17, "Digit6": 0x16, "Digit7": 0x1A, "Digit8": 0x1C, "Digit9": 0x19,
  "KeyA": 0x00, "KeyB": 0x0B, "KeyC": 0x08, "KeyD": 0x02, "KeyE": 0x0E, "KeyF": 0x03,
  "KeyG": 0x05, "KeyH": 0x04, "KeyI": 0x22, "KeyJ": 0x26, "KeyK": 0x28, "KeyL": 0x25,
  "KeyM": 0x2E, "KeyN": 0x2D, "KeyO": 0x1F, "KeyP": 0x23, "KeyQ": 0x0C, "KeyR": 0x0F,
  "KeyS": 0x01, "KeyT": 0x11, "KeyU": 0x20, "KeyV": 0x09, "KeyW": 0x0D, "KeyX": 0x07,
  "KeyY": 0x10, "KeyZ": 0x06,
  "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61,
  "F7": 0x62, "F8": 0x64, "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,
]

// C-compatible Carbon callback (no context capture) → dispatch to the shared manager.
private func unnestHotKeyHandler(_ next: EventHandlerCallRef?, _ ev: EventRef?,
                                 _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    var hkID = EventHotKeyID()
    GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                      nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
    UnnestHotkeys.shared.fire(id: hkID.id)
    return noErr
}

final class UnnestHotkeys {
    static let shared = UnnestHotkeys()
    private var refs: [EventHotKeyRef?] = []
    private var idToMode: [UInt32: String] = [:]
    private var handlerInstalled = false
    private var lastConfig = ""
    private let modes = ["video", "av", "avt"]   // hotkey id = index + 1
    private let sig: OSType = 0x554E5354         // 'UNST'
    private var hkFile: String {
        (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/ClaudeBridge/hotkeys.json")
    }
    private let defaults: [String: [String: Any]] = [
        "video": ["code": "Digit1", "cmd": true, "opt": true, "ctrl": true, "shift": false],
        "av":    ["code": "Digit2", "cmd": true, "opt": true, "ctrl": true, "shift": false],
        "avt":   ["code": "Digit3", "cmd": true, "opt": true, "ctrl": true, "shift": false],
    ]

    func start() {
        installHandlerIfNeeded()
        reloadAndRegister()
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.reloadIfChanged() }
    }

    private func installHandlerIfNeeded() {
        guard !handlerInstalled else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), unnestHotKeyHandler, 1, &spec, nil, nil)
        handlerInstalled = true
    }

    private func readConfig() -> [String: [String: Any]] {
        guard let data = FileManager.default.contents(atPath: hkFile),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return defaults }
        var out = defaults
        for m in modes { if let e = obj[m] as? [String: Any] { out[m] = e } }
        return out
    }

    private func reloadIfChanged() {
        let cur = (try? String(contentsOfFile: hkFile, encoding: .utf8)) ?? ""
        if cur != lastConfig { reloadAndRegister() }
    }

    private func reloadAndRegister() {
        lastConfig = (try? String(contentsOfFile: hkFile, encoding: .utf8)) ?? ""
        for r in refs { if let r = r { UnregisterEventHotKey(r) } }
        refs.removeAll(); idToMode.removeAll()
        let cfg = readConfig()
        for (i, mode) in modes.enumerated() {
            guard let e = cfg[mode], let code = e["code"] as? String, let kc = kVKByCode[code] else { continue }
            var mods: UInt32 = 0
            if (e["cmd"]   as? Bool) == true { mods |= UInt32(cmdKey) }
            if (e["opt"]   as? Bool) == true { mods |= UInt32(optionKey) }
            if (e["ctrl"]  as? Bool) == true { mods |= UInt32(controlKey) }
            if (e["shift"] as? Bool) == true { mods |= UInt32(shiftKey) }
            if mods == 0 { continue }   // require at least one modifier
            let id = UInt32(i + 1)
            var ref: EventHotKeyRef?
            let hotID = EventHotKeyID(signature: sig, id: id)
            if RegisterEventHotKey(kc, mods, hotID, GetApplicationEventTarget(), 0, &ref) == noErr {
                refs.append(ref); idToMode[id] = mode
            }
        }
    }

    func fire(id: UInt32) {
        guard let mode = idToMode[id] else { return }
        guard let url = URL(string: "http://localhost:3030/unnest/trigger") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["mode": mode])
        URLSession.shared.dataTask(with: req).resume()
    }
}
