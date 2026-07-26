import Foundation

/// Supervises the Go server child process (the embedded HLS/admin server):
/// starts it, restarts it if it crashes, and tears it down on quit.
final class ServerController {
    let port: Int
    private var process: Process?
    private var stopping = false
    private var restartCount = 0
    private var lastStart = Date.distantPast

    init(port: Int = 8000) {
        self.port = port
    }

    /// Locate the Go server binary. In the .app it ships at
    /// Contents/Helpers/partyparty-server (sibling of the Swift app in
    /// Contents/MacOS). For `swift run` dev, set PARTYPARTY_SERVER=/path/to/binary.
    private func serverPath() -> String? {
        let env = ProcessInfo.processInfo.environment
        if let p = env["PARTYPARTY_SERVER"], !p.isEmpty, FileManager.default.fileExists(atPath: p) {
            return p
        }
        let exe = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        // Contents/MacOS/partyparty -> Contents/Helpers/partyparty-server
        let candidate = exe
            .deletingLastPathComponent()       // Contents/MacOS
            .deletingLastPathComponent()       // Contents
            .appendingPathComponent("Helpers/partyparty-server")
            .path
        return FileManager.default.fileExists(atPath: candidate) ? candidate : nil
    }

    func start() {
        guard process == nil else { return }
        guard let path = serverPath() else {
            NSLog("partyparty: server binary not found (set PARTYPARTY_SERVER for dev)")
            return
        }
        stopping = false
#if !APP_STORE
        reapOrphans()  // kill a stale server from a previous instance so we bind clean
#endif
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["--no-open", "--port", String(port)]
        p.environment = ProcessInfo.processInfo.environment
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.childExited(proc) }
        }
        do {
            try p.run()
            process = p
            lastStart = Date()
        } catch {
            NSLog("partyparty: failed to start server: \(error)")
        }
    }

#if !APP_STORE
    /// Kill any orphaned server child from a previous app instance before we
    /// spawn a fresh one. THIS is the after-update white-screen fix: Sparkle (or
    /// a force-quit / crash) can leave the old `partyparty-server` holding port
    /// 8000, so the new console loads nothing. At start() we own no child yet, so
    /// any running server binary is by definition an orphan — reap it (SIGTERM,
    /// then SIGKILL stragglers) and wait for the port to free.
    private func reapOrphans() {
        for signal in ["-TERM", "-KILL"] {
            let pk = Process()
            pk.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
            // Match the server binary's argv; "partyparty-server" is unique to the
            // child (the app itself is .../MacOS/partyparty, no "-server").
            pk.arguments = [signal, "-f", "partyparty-server --no-open"]
            do { try pk.run(); pk.waitUntilExit() } catch { break }
            if signal == "-TERM" {
                // Give a graceful exit a moment; skip the KILL if the port frees.
                let deadline = Date().addingTimeInterval(2.5)
                while portInUse() && Date() < deadline { usleep(100_000) }
                if !portInUse() { return }
            }
        }
        let deadline = Date().addingTimeInterval(1.5)
        while portInUse() && Date() < deadline { usleep(100_000) }
    }

    /// True if something is still listening on our loopback port.
    private func portInUse() -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return rc == 0
    }
#endif

    func restart() {
        stop()
        restartCount = 0
        start()
    }

    /// Actual supervision: a crashed server comes back on its own (the app
    /// used to run forever with a dead console). Restart only on ABNORMAL
    /// exits — a clean exit(0) is deliberate (e.g. the orphan reaper asked us
    /// to yield the port to a newer instance) and must NOT resurrect.
    private func childExited(_ proc: Process) {
        guard process === proc, !stopping else { return } // our stop(), or an old child
        process = nil
        let abnormal = proc.terminationStatus != 0 || proc.terminationReason == .uncaughtSignal
        guard abnormal else { return }
        if Date().timeIntervalSince(lastStart) > 60 { restartCount = 0 } // healthy run resets the budget
        restartCount += 1
        guard restartCount <= 5 else {
            NSLog("partyparty: server keeps dying (status \(proc.terminationStatus)) — giving up")
            return
        }
        NSLog("partyparty: server exited (status \(proc.terminationStatus)) — restarting \(restartCount)/5")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.start() }
    }

    /// SIGTERM (graceful Go shutdown: http.Server.Shutdown + ffmpeg/mediamtx teardown),
    /// then SIGKILL if it overstays — so ports are released before relaunch.
    func stop() {
        stopping = true
        guard let p = process, p.isRunning else { process = nil; return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
    }
}
