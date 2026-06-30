import Foundation

/// Supervises the Go server child process (the embedded HLS/admin server).
final class ServerController {
    let port: Int
    private var process: Process?

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
        do {
            try p.run()
            process = p
        } catch {
            NSLog("partyparty: failed to start server: \(error)")
        }
    }

    /// SIGTERM (graceful Go shutdown: http.Server.Shutdown + ffmpeg/mediamtx teardown),
    /// then SIGKILL if it overstays — so ports are released before relaunch.
    func stop() {
        guard let p = process, p.isRunning else { process = nil; return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
    }
}
