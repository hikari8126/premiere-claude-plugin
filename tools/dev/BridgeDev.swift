// tools/dev/BridgeDev.swift — "Claude Bridge DEV.app": icon menu bar điều khiển bản DEV
// (plugin "Claude AI DEV" + bridge chạy từ repo ở :3035) thay cho gõ `bash dev.sh` trong Terminal.
//
// Không dùng lại bridge-app/main.swift: app thật có phím tắt toàn cục, tự cập nhật, login item…
// chạy hai bản sẽ giẫm nhau. App này chỉ gọi dev.sh và hiện trạng thái:
//   mở app        → dev.sh (dựng plugin DEV, khởi động bridge dev, load/reload vào Premiere)
//   Dựng lại      → dev.sh            Tắt bản DEV → dev.sh stop        Thoát → dev.sh stop
//   Tự reload khi sửa code → thấy file trong plugin/ hoặc bridge/ đổi thì tự chạy dev.sh
// Build: bash dev.sh app  (tools/dev/build-dev-app.sh)

import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let repo: String
    let port: String
    var item: NSStatusItem!
    var busy = false
    var bridgeUp = false
    var lastMsg = "Đang khởi động…"
    var lastOk = true
    var snapshot: [String: Date] = [:]
    var changedAt: Date? = nil

    var autoReload: Bool {
        get { UserDefaults.standard.object(forKey: "autoReload") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "autoReload") }
    }

    init(repo: String) {
        self.repo = repo
        self.port = ProcessInfo.processInfo.environment["DEV_PORT"] ?? "3035"
        super.init()
    }

    var devDir: String { repo + "/.dev" }
    var pluginLoaded: Bool { FileManager.default.fileExists(atPath: devDir + "/plugin.session") }

    func applicationDidFinishLaunching(_ n: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        paintTitle()
        snapshot = scan()
        run(["start"], label: "Khởi động bản DEV")
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
    }

    func applicationWillTerminate(_ n: Notification) {
        _ = runSync(["stop"])
    }

    // ── Gọi dev.sh qua login shell (lấy PATH của user: node, ffmpeg, python3) ──
    func makeProcess(_ args: [String]) -> (Process, Pipe) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "cd \"$1\" && shift && bash dev.sh \"$@\"", "bridge-dev", repo] + args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        return (p, pipe)
    }

    func run(_ args: [String], label: String) {
        if busy { return }
        busy = true
        lastMsg = label + "…"
        paintTitle()
        let (p, pipe) = makeProcess(args)
        p.terminationHandler = { [weak self] proc in
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let lines = out.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.busy = false
                self.lastOk = proc.terminationStatus == 0
                let fail = lines.last(where: { $0.hasPrefix("✗") })
                self.lastMsg = (self.lastOk ? lines.last : (fail ?? lines.last)) ?? (self.lastOk ? "Xong" : "Lỗi (xem log)")
                self.snapshot = self.scan()
                self.changedAt = nil
                self.paintTitle()
                self.notify(self.lastOk ? "Bản DEV" : "Bản DEV lỗi", self.lastMsg)
            }
        }
        do { try p.run() } catch {
            busy = false
            lastOk = false
            lastMsg = "Không chạy được dev.sh: \(error.localizedDescription)"
            paintTitle()
        }
    }

    func runSync(_ args: [String]) -> Int32 {
        let (p, _) = makeProcess(args)
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
    }

    func notify(_ title: String, _ body: String) {
        let esc = { (s: String) in s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\""]
        try? p.run()
    }

    // ── Trạng thái: bridge sống không, code có đổi không ──
    func tick() {
        var req = URLRequest(url: URL(string: "http://localhost:\(port)/health")!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            let up = (resp as? HTTPURLResponse)?.statusCode == 200 && data != nil
            DispatchQueue.main.async {
                guard let self = self else { return }
                if up != self.bridgeUp { self.bridgeUp = up; self.paintTitle() }
            }
        }.resume()
        guard autoReload, !busy else { return }
        let now = scan()
        if now != snapshot {
            snapshot = now
            changedAt = Date()   // chờ ngừng sửa ~2s rồi mới reload (lưu nhiều file liền nhau)
        } else if let t = changedAt, Date().timeIntervalSince(t) >= 2 {
            changedAt = nil
            run(["start"], label: "Code đổi — tự reload")
        }
    }

    // mtime của plugin/* và bridge/*.js, bridge/rawcut-engine/* (bỏ node_modules, file ẩn).
    func scan() -> [String: Date] {
        var out: [String: Date] = [:]
        let fm = FileManager.default
        func add(_ dir: String, recursive: Bool) {
            guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return }
            for n in names where !n.hasPrefix(".") && n != "node_modules" {
                let p = dir + "/" + n
                var isDir: ObjCBool = false
                guard fm.fileExists(atPath: p, isDirectory: &isDir) else { continue }
                if isDir.boolValue {
                    if recursive || n == "rawcut-engine" { add(p, recursive: true) }
                } else if let d = (try? fm.attributesOfItem(atPath: p))?[.modificationDate] as? Date {
                    if dir.hasSuffix("/bridge") && !n.hasSuffix(".js") { continue }
                    out[p] = d
                }
            }
        }
        add(repo + "/plugin", recursive: true)
        add(repo + "/bridge", recursive: false)
        return out
    }

    // ── Menu bar ──
    func paintTitle() {
        guard let b = item?.button else { return }
        let dot: String, color: NSColor
        if busy { dot = " …"; color = .systemOrange }
        else if !lastOk { dot = " ✕"; color = .systemRed }
        else if bridgeUp { dot = " ●"; color = .systemGreen }
        else { dot = " ○"; color = .secondaryLabelColor }
        let s = NSMutableAttributedString(string: "DEV", attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .bold)])
        s.append(NSAttributedString(string: dot, attributes: [.foregroundColor: color, .font: NSFont.systemFont(ofSize: 12)]))
        b.attributedTitle = s
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        func info(_ t: String) { let i = NSMenuItem(title: t, action: nil, keyEquivalent: ""); i.isEnabled = false; menu.addItem(i) }
        func act(_ t: String, _ sel: Selector, _ key: String = "") -> NSMenuItem {
            let i = NSMenuItem(title: t, action: sel, keyEquivalent: key); i.target = self; menu.addItem(i); return i
        }
        info(bridgeUp ? "Bridge DEV: đang chạy ở :\(port)" : "Bridge DEV: đã tắt")
        info(pluginLoaded ? "Plugin DEV: đã load — Window → Extensions → Claude AI DEV" : "Plugin DEV: chưa load")
        info(String(lastMsg.prefix(90)))
        menu.addItem(.separator())
        let r = act(busy ? "Đang chạy…" : "Dựng lại & reload", #selector(doStart), "r")
        r.isEnabled = !busy
        let a = act("Tự reload khi sửa code", #selector(toggleAuto))
        a.state = autoReload ? .on : .off
        let s = act("Tắt bản DEV", #selector(doStop))
        s.isEnabled = !busy
        menu.addItem(.separator())
        _ = act("Xem log bridge DEV", #selector(openLog))
        _ = act("Mở thư mục repo", #selector(openRepo))
        menu.addItem(.separator())
        _ = act("Thoát (tắt bản DEV)", #selector(quit), "q")
    }

    @objc func doStart() { run(["start"], label: "Dựng lại & reload") }
    @objc func doStop() { run(["stop"], label: "Tắt bản DEV") }
    @objc func toggleAuto() { autoReload.toggle(); snapshot = scan(); changedAt = nil }
    @objc func openLog() {
        let log = devDir + "/bridge.log"
        if FileManager.default.fileExists(atPath: log) { NSWorkspace.shared.open(URL(fileURLWithPath: log)) }
    }
    @objc func openRepo() { NSWorkspace.shared.open(URL(fileURLWithPath: repo)) }
    @objc func quit() { NSApp.terminate(nil) }
}

// Repo: key ClaudeRepoPath ghi lúc build (app có bị kéo đi chỗ khác vẫn chạy), không có thì thư mục chứa app.
let repoPath = (Bundle.main.object(forInfoDictionaryKey: "ClaudeRepoPath") as? String)
    ?? Bundle.main.bundleURL.deletingLastPathComponent().path
let app = NSApplication.shared
let delegate = AppDelegate(repo: repoPath)
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
