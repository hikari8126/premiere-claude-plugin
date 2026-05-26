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
    var welcomeView:    NSView?
    var progressView:   NSView?
    var doneView:       NSView?

    // Progress labels
    var step1Label: NSTextField?
    var step2Label: NSTextField?
    var step3Label: NSTextField?
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
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 400),
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

        // Header
        let header = makeHeader()
        container.addSubview(header)

        // Body
        let body = NSView(frame: NSRect(x: 40, y: 100, width: 440, height: 220))

        let title = makeLabel("Chào mừng đến với Claude AI Plugin!", size: 18, bold: true, color: .white)
        title.frame = NSRect(x: 0, y: 185, width: 440, height: 26)
        body.addSubview(title)

        let sub = makeLabel("Trình cài đặt sẽ tự động:", size: 13, bold: false, color: NSColor(white: 0.75, alpha: 1))
        sub.frame = NSRect(x: 0, y: 155, width: 440, height: 20)
        body.addSubview(sub)

        let checks = [
            "⚡  Cài Claude Bridge vào Applications (quản lý AI server)",
            "🔌  Cài plugin CCX vào Adobe Premiere Pro",
            "🚀  Khởi động Bridge ngay sau khi cài xong",
        ]
        for (i, text) in checks.enumerated() {
            let lbl = makeLabel(text, size: 13, bold: false, color: NSColor(white: 0.85, alpha: 1))
            lbl.frame = NSRect(x: 12, y: 120 - i * 26, width: 420, height: 20)
            body.addSubview(lbl)
        }

        let req = makeLabel("Yêu cầu: macOS 13+  •  Adobe Premiere Pro 25.6+  •  Creative Cloud",
                             size: 11.5, bold: false,
                             color: NSColor(red: 0.55, green: 0.47, blue: 0.85, alpha: 1))
        req.frame = NSRect(x: 0, y: 12, width: 440, height: 18)
        body.addSubview(req)

        container.addSubview(body)

        // Button
        let btn = accentButton("Cài đặt ngay  →", target: self, action: #selector(startInstall))
        btn.frame = NSRect(x: 340, y: 18, width: 160, height: 38)
        container.addSubview(btn)

        window.contentView?.addSubview(container)
        welcomeView = container
    }

    // MARK: ─── Progress Screen ────────────────────────────────────────────
    func showProgress() {
        clearContent()

        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]

        let header = makeHeader()
        container.addSubview(header)

        let title = makeLabel("Đang cài đặt...", size: 18, bold: true, color: .white)
        title.frame = NSRect(x: 40, y: 320, width: 440, height: 26)
        container.addSubview(title)

        // Steps
        let steps: [(NSTextField?, NSRect)] = [
            (nil, NSRect(x: 40, y: 270, width: 440, height: 22)),
            (nil, NSRect(x: 40, y: 238, width: 440, height: 22)),
            (nil, NSRect(x: 40, y: 206, width: 440, height: 22)),
        ]
        let labels = [
            "⏳  Cài Claude Bridge.app vào /Applications...",
            "⏳  Cài plugin vào Premiere Pro...",
            "⏳  Khởi động Bridge...",
        ]

        var lblRefs: [NSTextField] = []
        for (i, (_, rect)) in steps.enumerated() {
            let lbl = makeLabel(labels[i], size: 13.5, bold: false, color: NSColor(white: 0.75, alpha: 1))
            lbl.frame = rect
            container.addSubview(lbl)
            lblRefs.append(lbl)
        }
        step1Label = lblRefs[0]
        step2Label = lblRefs[1]
        step3Label = lblRefs[2]

        // Progress bar
        let pb = NSProgressIndicator(frame: NSRect(x: 40, y: 155, width: 440, height: 14))
        pb.style         = .bar
        pb.isIndeterminate = false
        pb.minValue      = 0
        pb.maxValue      = 3
        pb.doubleValue   = 0
        pb.wantsLayer    = true
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
            ico.frame = NSRect(x: 220, y: 280, width: 80, height: 60)
            container.addSubview(ico)

            let title = makeLabel("Cài đặt hoàn thành!", size: 19, bold: true, color: .white)
            title.frame = NSRect(x: 40, y: 245, width: 440, height: 28)
            title.alignment = .center
            container.addSubview(title)

            let nextSteps = [
                "1️⃣   Creative Cloud đang cài plugin — chờ vài giây",
                "2️⃣   Mở Premiere Pro → Window → Extensions → Claude AI",
                "3️⃣   Bridge ⚡ đang chạy trong thanh menu — sẵn sàng!",
            ]
            for (i, text) in nextSteps.enumerated() {
                let lbl = makeLabel(text, size: 13, bold: false, color: NSColor(white: 0.82, alpha: 1))
                lbl.frame = NSRect(x: 40, y: 195 - i * 30, width: 440, height: 22)
                container.addSubview(lbl)
            }

        } else {
            let ico = makeLabel("❌", size: 44, bold: false, color: .white)
            ico.frame = NSRect(x: 220, y: 280, width: 80, height: 60)
            container.addSubview(ico)

            let title = makeLabel("Cài đặt thất bại", size: 19, bold: true, color: NSColor(red: 1, green: 0.4, blue: 0.4, alpha: 1))
            title.frame = NSRect(x: 40, y: 248, width: 440, height: 28)
            title.alignment = .center
            container.addSubview(title)

            let errLbl = makeLabel(errorMsg, size: 12, bold: false,
                                   color: NSColor(white: 0.70, alpha: 1))
            errLbl.frame = NSRect(x: 40, y: 120, width: 440, height: 120)
            errLbl.maximumNumberOfLines = 6
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
            // Locate bundled resources
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

            // ── Step 1: Copy Claude Bridge.app → /Applications ────────────
            DispatchQueue.main.async { self.setStep(1, status: .running) }

            let dest = "/Applications/Claude Bridge.app"
            do {
                if FileManager.default.fileExists(atPath: dest) {
                    try FileManager.default.removeItem(atPath: dest)
                }
                try FileManager.default.copyItem(atPath: bridgeApp, toPath: dest)
                // Remove quarantine
                let q = self.sh("xattr -dr com.apple.quarantine '\(dest)' 2>/dev/null || true")
                _ = q
            } catch {
                DispatchQueue.main.async {
                    self.setStep(1, status: .failed)
                    self.showDone(success: false,
                                  errorMsg: "Không thể copy Claude Bridge.app:\n\(error.localizedDescription)\n\nThử chạy installer bằng right-click → Open.")
                }
                return
            }

            DispatchQueue.main.async {
                self.setStep(1, status: .done)
                self.progressBar?.doubleValue = 1
            }

            // ── Step 2: Install CCX plugin ────────────────────────────────
            DispatchQueue.main.async { self.setStep(2, status: .running) }

            if FileManager.default.fileExists(atPath: ccxPath) {
                NSWorkspace.shared.open(URL(fileURLWithPath: ccxPath))
                Thread.sleep(forTimeInterval: 1.5)   // give Creative Cloud time to catch it
            }
            // CCX open is fire-and-forget — Creative Cloud handles the rest

            DispatchQueue.main.async {
                self.setStep(2, status: .done)
                self.progressBar?.doubleValue = 2
            }

            // ── Step 3: Launch Claude Bridge ──────────────────────────────
            DispatchQueue.main.async { self.setStep(3, status: .running) }
            Thread.sleep(forTimeInterval: 0.5)

            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(fileURLWithPath: dest))
                self.setStep(3, status: .done)
                self.progressBar?.doubleValue = 3
            }

            Thread.sleep(forTimeInterval: 1.0)
            DispatchQueue.main.async { self.showDone(success: true) }
        }
    }

    enum StepStatus { case running, done, failed }

    func setStep(_ step: Int, status: StepStatus) {
        let labels = [step1Label, step2Label, step3Label]
        guard step >= 1, step <= 3, let lbl = labels[step - 1] else { return }

        let baseTexts = [
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

        lbl.stringValue  = prefix + baseTexts[step - 1]
        lbl.textColor    = color
    }

    @objc func finish() { NSApp.terminate(nil) }

    func clearContent() {
        window.contentView?.subviews.forEach { $0.removeFromSuperview() }
        welcomeView = nil; progressView = nil; doneView = nil
        step1Label  = nil; step2Label   = nil; step3Label = nil
        progressBar = nil
    }

    // MARK: ─── UI Helpers ─────────────────────────────────────────────────
    func makeHeader() -> NSView {
        let h = NSView(frame: NSRect(x: 0, y: 348, width: 520, height: 52))
        h.wantsLayer = true
        h.layer?.backgroundColor = NSColor(red: 0.28, green: 0.18, blue: 0.55, alpha: 1).cgColor

        let ico  = makeLabel("🎬", size: 22, bold: false, color: .white)
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

    @discardableResult
    func sh(_ cmd: String) -> String {
        let p = Process()
        p.launchPath  = "/bin/bash"
        p.arguments   = ["-c", cmd]
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
        try? p.run(); p.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}
