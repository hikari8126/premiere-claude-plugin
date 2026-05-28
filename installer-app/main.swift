import Cocoa
import Foundation

// ── Entry point ────────────────────────────────────────────────────────────
let app = NSApplication.shared
NSApp.setActivationPolicy(.regular)
let delegate = InstallerDelegate()
app.delegate = delegate
app.run()

// ── Installer Delegate ─────────────────────────────────────────────────────
class InstallerDelegate: NSObject, NSApplicationDelegate {

    var window: NSWindow!

    // Panels
    var welcomeView:  NSView?
    var progressView: NSView?
    var doneView:     NSView?

    // Progress labels (4 steps)
    var step1Label:  NSTextField?
    var step2Label:  NSTextField?
    var step3Label:  NSTextField?
    var step4Label:  NSTextField?
    var progressBar: NSProgressIndicator?

    func applicationDidFinishLaunching(_ n: Notification) {
        buildWindow()
        showWelcome()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: ─── Window ─────────────────────────────────────────────────────
    func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 420),
            styleMask:   [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false)
        window.title = "Claude AI Plugin — Cài đặt"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView?.wantsLayer = true
        window.contentView?.layer?.backgroundColor = NSColor(red: 0.08, green: 0.06, blue: 0.14, alpha: 1).cgColor
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: ─── Welcome Screen ─────────────────────────────────────────────
    func showWelcome() {
        clearContent()

        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]

        let header = makeHeader()
        container.addSubview(header)

        let body = NSView(frame: NSRect(x: 40, y: 90, width: 440, height: 260))

        let title = makeLabel("Chào mừng đến với Claude AI Plugin!", size: 18, bold: true, color: .white)
        title.frame = NSRect(x: 0, y: 225, width: 440, height: 26)
        body.addSubview(title)

        let sub = makeLabel("Trình cài đặt sẽ tự động:", size: 13, bold: false, color: NSColor(white: 0.75, alpha: 1))
        sub.frame = NSRect(x: 0, y: 195, width: 440, height: 20)
        body.addSubview(sub)

        let checks = [
            "🔧  Kiểm tra & cài Node.js (môi trường chạy Bridge)",
            "⚡  Cài Claude Bridge vào Applications (quản lý AI server)",
            "🔌  Cài plugin CCX vào Adobe Premiere Pro",
            "🚀  Khởi động Bridge ngay sau khi cài xong",
        ]
        for (i, text) in checks.enumerated() {
            let lbl = makeLabel(text, size: 13, bold: false, color: NSColor(white: 0.85, alpha: 1))
            lbl.frame = NSRect(x: 12, y: 152 - i * 28, width: 420, height: 20)
            body.addSubview(lbl)
        }

        let req = makeLabel("Yêu cầu: macOS 13+  •  Adobe Premiere Pro 25.6+  •  Creative Cloud",
                             size: 11.5, bold: false,
                             color: NSColor(red: 0.55, green: 0.47, blue: 0.85, alpha: 1))
        req.frame = NSRect(x: 0, y: 8, width: 440, height: 18)
        body.addSubview(req)

        container.addSubview(body)

        let btn = accentButton("Cài đặt ngay  →", target: self, action: #selector(startInstall))
        btn.frame = NSRect(x: 340, y: 18, width: 160, height: 38)
        container.addSubview(btn)

        window.contentView?.addSubview(container)
        welcomeView = container
    }

    // MARK: ─── Progress Screen (4 steps) ─────────────────────────────────
    func showProgress() {
        clearContent()

        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]

        let header = makeHeader()
        container.addSubview(header)

        let title = makeLabel("Đang cài đặt...", size: 18, bold: true, color: .white)
        title.frame = NSRect(x: 40, y: 340, width: 440, height: 26)
        container.addSubview(title)

        // 4 steps, evenly spaced
        let stepYs = [295, 260, 225, 190]
        let stepTexts = [
            "⏳  Kiểm tra & cài Node.js...",
            "⏳  Claude Bridge.app → /Applications...",
            "⏳  Plugin CCX → Premiere Pro (Creative Cloud)...",
            "⏳  Khởi động Claude Bridge...",
        ]
        var lblRefs: [NSTextField] = []
        for (i, text) in stepTexts.enumerated() {
            let lbl = makeLabel(text, size: 13, bold: false, color: NSColor(white: 0.75, alpha: 1))
            lbl.frame = NSRect(x: 40, y: CGFloat(stepYs[i]), width: 440, height: 22)
            container.addSubview(lbl)
            lblRefs.append(lbl)
        }
        step1Label = lblRefs[0]
        step2Label = lblRefs[1]
        step3Label = lblRefs[2]
        step4Label = lblRefs[3]

        // Progress bar
        let pb = NSProgressIndicator(frame: NSRect(x: 40, y: 155, width: 440, height: 14))
        pb.style          = .bar
        pb.isIndeterminate = false
        pb.minValue       = 0
        pb.maxValue       = 4
        pb.doubleValue    = 0
        pb.wantsLayer     = true
        container.addSubview(pb)
        progressBar = pb

        window.contentView?.addSubview(container)
        progressView = container
    }

    // MARK: ─── Done Screen ────────────────────────────────────────────────
    func showDone(success: Bool, errorMsg: String = "") {
        clearContent()

        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]

        let header = makeHeader()
        container.addSubview(header)

        if success {
            let ico = makeLabel("✅", size: 44, bold: false, color: .white)
            ico.frame = NSRect(x: 220, y: 300, width: 80, height: 60)
            container.addSubview(ico)

            let title = makeLabel("Cài đặt hoàn thành!", size: 19, bold: true, color: .white)
            title.frame = NSRect(x: 40, y: 265, width: 440, height: 28)
            title.alignment = .center
            container.addSubview(title)

            let nextSteps = [
                "1️⃣   Creative Cloud đang cài plugin — chờ vài giây",
                "2️⃣   Mở Premiere Pro → Window → Extensions → Claude AI",
                "3️⃣   Bridge ⚡ đang chạy trong thanh menu — sẵn sàng!",
            ]
            for (i, text) in nextSteps.enumerated() {
                let lbl = makeLabel(text, size: 13, bold: false, color: NSColor(white: 0.82, alpha: 1))
                lbl.frame = NSRect(x: 40, y: 215 - i * 30, width: 440, height: 22)
                container.addSubview(lbl)
            }

        } else {
            let ico = makeLabel("❌", size: 44, bold: false, color: .white)
            ico.frame = NSRect(x: 220, y: 300, width: 80, height: 60)
            container.addSubview(ico)

            let title = makeLabel("Cài đặt thất bại", size: 19, bold: true,
                                   color: NSColor(red: 1, green: 0.4, blue: 0.4, alpha: 1))
            title.frame = NSRect(x: 40, y: 265, width: 440, height: 28)
            title.alignment = .center
            container.addSubview(title)

            let errLbl = makeLabel(errorMsg, size: 12, bold: false, color: NSColor(white: 0.70, alpha: 1))
            errLbl.frame = NSRect(x: 40, y: 120, width: 440, height: 130)
            errLbl.maximumNumberOfLines = 7
            container.addSubview(errLbl)
        }

        let btn = accentButton(success ? "Hoàn thành" : "Thử lại", target: self,
                               action: success ? #selector(finish) : #selector(startInstall))
        btn.frame = NSRect(x: 340, y: 20, width: 140, height: 36)
        container.addSubview(btn)

        window.contentView?.addSubview(container)
        doneView = container
    }

    // MARK: ─── Install Logic ──────────────────────────────────────────────
    @objc func startInstall() {
        showProgress()

        DispatchQueue.global(qos: .userInitiated).async {
            guard let rp = Bundle.main.resourcePath else {
                DispatchQueue.main.async {
                    self.showDone(success: false, errorMsg: "Không tìm thấy Resources trong bundle.")
                }
                return
            }

            let bridgeApp = rp + "/Claude Bridge.app"
            let ccxPath   = rp + "/plugin.ccx"

            guard FileManager.default.fileExists(atPath: bridgeApp) else {
                DispatchQueue.main.async {
                    self.showDone(success: false,
                                  errorMsg: "Không tìm thấy 'Claude Bridge.app' trong installer.\nVui lòng tải lại bản cài đặt từ GitHub.")
                }
                return
            }

            // ── Step 1: Check / install Node.js ───────────────────────────
            DispatchQueue.main.async { self.setStep(1, status: .running) }

            let nodeOK = self.ensureNode()
            if !nodeOK {
                DispatchQueue.main.async {
                    self.setStep(1, status: .failed)
                    self.showDone(success: false,
                                  errorMsg: "Không tìm thấy Node.js sau khi cài đặt.\n\nVui lòng cài thủ công tại https://nodejs.org rồi chạy lại installer.")
                }
                return
            }

            DispatchQueue.main.async {
                self.setStep(1, status: .done)
                self.progressBar?.doubleValue = 1
            }

            // ── Step 2: Copy Claude Bridge.app → /Applications ────────────
            DispatchQueue.main.async { self.setStep(2, status: .running) }

            let dest = "/Applications/Claude Bridge.app"
            do {
                if FileManager.default.fileExists(atPath: dest) {
                    try FileManager.default.removeItem(atPath: dest)
                }
                try FileManager.default.copyItem(atPath: bridgeApp, toPath: dest)
                _ = self.sh("xattr -dr com.apple.quarantine '\(dest)' 2>/dev/null || true")
            } catch {
                DispatchQueue.main.async {
                    self.setStep(2, status: .failed)
                    self.showDone(success: false,
                                  errorMsg: "Không thể copy Claude Bridge.app:\n\(error.localizedDescription)\n\nThử chạy installer bằng right-click → Open.")
                }
                return
            }

            DispatchQueue.main.async {
                self.setStep(2, status: .done)
                self.progressBar?.doubleValue = 2
            }

            // ── Step 3: Install CCX plugin ────────────────────────────────
            DispatchQueue.main.async { self.setStep(3, status: .running) }

            if FileManager.default.fileExists(atPath: ccxPath) {
                NSWorkspace.shared.open(URL(fileURLWithPath: ccxPath))
                Thread.sleep(forTimeInterval: 1.5)
            }

            DispatchQueue.main.async {
                self.setStep(3, status: .done)
                self.progressBar?.doubleValue = 3
            }

            // ── Step 4: Launch Claude Bridge ──────────────────────────────
            DispatchQueue.main.async { self.setStep(4, status: .running) }
            Thread.sleep(forTimeInterval: 0.5)

            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(fileURLWithPath: dest))
                self.setStep(4, status: .done)
                self.progressBar?.doubleValue = 4
            }

            Thread.sleep(forTimeInterval: 1.0)
            DispatchQueue.main.async { self.showDone(success: true) }
        }
    }

    // MARK: ─── Node.js Prerequisite ──────────────────────────────────────

    func findNode() -> String {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            NSHomeDirectory() + "/.nvm/versions/node/current/bin/node",
            NSHomeDirectory() + "/.volta/bin/node",
        ]
        if let found = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) {
            return found
        }
        let r = sh("/usr/bin/which node 2>/dev/null")
        return r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func findBrew() -> String {
        let candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        if let found = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) {
            return found
        }
        let r = sh("/usr/bin/which brew 2>/dev/null")
        return r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Returns true if Node.js is available (installing if needed).
    // Runs on background thread — must not call UI from here directly.
    func ensureNode() -> Bool {
        // Already installed?
        if !findNode().isEmpty { return true }

        // Ask user whether to install
        var userConfirmed = false
        let sema = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            let a = NSAlert()
            a.messageText     = "Cần cài Node.js"
            a.informativeText = "Node.js chưa được cài. Bridge server cần Node.js để chạy.\n\nBấm \"Cài ngay\" — Terminal sẽ mở và cài tự động (~2 phút).\nBấm \"Bỏ qua\" nếu bạn muốn tự cài sau."
            a.alertStyle      = .informational
            a.addButton(withTitle: "Cài ngay")
            a.addButton(withTitle: "Bỏ qua")
            userConfirmed = a.runModal() == .alertFirstButtonReturn
            sema.signal()
        }
        sema.wait()
        guard userConfirmed else { return false }

        // Try Homebrew first; otherwise install Homebrew too
        let brew = findBrew()
        let installCmd: String
        if !brew.isEmpty {
            // Homebrew present — just install node
            installCmd = "'\(brew)' install node 2>&1 && echo '✅ Node.js đã cài xong! Đóng cửa sổ này.'"
        } else {
            // Install Homebrew first, then node
            installCmd = """
            echo '🔧 Cài Homebrew...' && \
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && \
            eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)" && \
            echo '🔧 Cài Node.js...' && \
            brew install node 2>&1 && \
            echo '✅ Cài xong! Đóng cửa sổ Terminal này để tiếp tục.'
            """
        }
        DispatchQueue.main.async { self.openTerminal(installCmd) }

        // Poll every 4 s, up to 5 min
        var waited = 0
        while waited < 300 {
            Thread.sleep(forTimeInterval: 4)
            waited += 4
            if !findNode().isEmpty { return true }
        }
        return false
    }

    // MARK: ─── Step Status ────────────────────────────────────────────────
    enum StepStatus { case running, done, failed }

    func setStep(_ step: Int, status: StepStatus) {
        let labels = [step1Label, step2Label, step3Label, step4Label]
        guard step >= 1, step <= 4, let lbl = labels[step - 1] else { return }

        let baseTexts = [
            "Node.js (môi trường chạy Bridge)",
            "Claude Bridge.app → /Applications",
            "Plugin CCX → Premiere Pro (Creative Cloud)",
            "Khởi động Claude Bridge",
        ]

        let prefix: String
        let color: NSColor
        switch status {
        case .running:
            prefix = "⏳  "
            color  = NSColor(white: 0.75, alpha: 1)
        case .done:
            prefix = "✅  "
            color  = NSColor(red: 0.4, green: 0.9, blue: 0.5, alpha: 1)
        case .failed:
            prefix = "❌  "
            color  = NSColor(red: 1, green: 0.4, blue: 0.4, alpha: 1)
        }

        lbl.stringValue = prefix + baseTexts[step - 1]
        lbl.textColor   = color
    }

    @objc func finish() { NSApp.terminate(nil) }

    func clearContent() {
        window.contentView?.subviews.forEach { $0.removeFromSuperview() }
        welcomeView = nil; progressView = nil; doneView = nil
        step1Label  = nil; step2Label   = nil
        step3Label  = nil; step4Label   = nil
        progressBar = nil
    }

    // MARK: ─── UI Helpers ─────────────────────────────────────────────────
    func makeHeader() -> NSView {
        let h = NSView(frame: NSRect(x: 0, y: 368, width: 520, height: 52))
        h.wantsLayer = true
        h.layer?.backgroundColor = NSColor(red: 0.28, green: 0.18, blue: 0.55, alpha: 1).cgColor

        let ico = makeLabel("🎬", size: 22, bold: false, color: .white)
        ico.frame = NSRect(x: 14, y: 12, width: 32, height: 30)
        h.addSubview(ico)

        let t = makeLabel("Claude AI Plugin  ·  Adobe Premiere Pro", size: 14, bold: true, color: .white)
        t.frame = NSRect(x: 50, y: 16, width: 400, height: 20)
        h.addSubview(t)

        return h
    }

    func makeLabel(_ text: String, size: CGFloat, bold: Bool, color: NSColor) -> NSTextField {
        let f = NSTextField(labelWithString: text)
        f.font      = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        f.textColor = color
        f.lineBreakMode = .byWordWrapping
        f.maximumNumberOfLines = 3
        f.drawsBackground = false
        f.isBordered      = false
        return f
    }

    func accentButton(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        let b = NSButton(title: title, target: target, action: action)
        b.bezelStyle  = .rounded
        b.wantsLayer  = true
        b.layer?.backgroundColor = NSColor(red: 0.44, green: 0.30, blue: 0.85, alpha: 1).cgColor
        b.layer?.cornerRadius    = 8
        b.contentTintColor       = .white
        b.font                   = .boldSystemFont(ofSize: 14)
        b.isBordered             = false
        return b
    }

    func openTerminal(_ cmd: String) {
        let escaped = cmd
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let src = "tell application \"Terminal\" to activate\ntell application \"Terminal\" to do script \"\(escaped)\""
        if let s = NSAppleScript(source: src) { s.executeAndReturnError(nil) }
    }

    @discardableResult
    func sh(_ cmd: String) -> (out: String, status: Int32) {
        let p = Process()
        p.launchPath = "/bin/bash"
        p.arguments  = ["-c", cmd]
        p.environment = [
            "PATH": "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin",
            "HOME": NSHomeDirectory(),
        ]
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
        try? p.run(); p.waitUntilExit()
        return (String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "",
                p.terminationStatus)
    }
}
