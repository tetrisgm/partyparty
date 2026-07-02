import Foundation

/// Supervises the Go server child process (the embedded HLS/admin server):
/// starts it, restarts it if it crashes, and tears it down on quit.
final class ServerController {
    let port: Int
    private var process: Process?
    private var stopping = false
    private var restartCount = 0
    private var lastStart = Date.distantPast

    init(port: Int = 8000) { self.port = port }

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
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["--no-open", "--port", String(port)]
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
