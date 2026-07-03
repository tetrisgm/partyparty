import AppKit
import Foundation

private let stateURL = URL(string: "https://party.ramine.net/content/state.json")!
private let payloadURL = URL(string: "https://party.ramine.net/partyparty.zip")!
private let manualDownloadURL = URL(string: "https://party.ramine.net/")!

private struct ReleaseState: Decodable {
    let appVersion: String?
}

private enum InstallerUpdate {
    case status(String)
    case progress(Double?)
}

private enum InstallerFailure: LocalizedError {
    case badHTTPStatus(Int)
    case missingDownloadedApp
    case commandFailed(String, Int32, String)

    var errorDescription: String? {
        switch self {
        case .badHTTPStatus(let code):
            return "Download failed with HTTP status \(code)."
        case .missingDownloadedApp:
            return "The downloaded archive did not contain partyparty.app."
        case .commandFailed(let tool, let status, let output):
            let detail = output.trimmingCharacters(in: .whitespacesAndNewlines)
            if detail.isEmpty {
                return "\(tool) exited with status \(status)."
            }
            return "\(tool) exited with status \(status): \(detail)"
        }
    }
}

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private let destination: URL
    private let progress: (Double?) -> Void
    private var continuation: CheckedContinuation<URL, Error>?
    private var session: URLSession?
    private let lock = NSLock()

    init(destination: URL, progress: @escaping (Double?) -> Void) {
        self.destination = destination
        self.progress = progress
    }

    func download(from url: URL) async throws -> URL {
        defer {
            session?.finishTasksAndInvalidate()
            session = nil
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation

            let configuration = URLSessionConfiguration.ephemeral
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            self.session = session

            var request = URLRequest(url: url)
            request.timeoutInterval = 60
            session.downloadTask(with: request).resume()
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard totalBytesExpectedToWrite > 0 else {
            progress(nil)
            return
        }
        progress(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        if let response = downloadTask.response as? HTTPURLResponse,
           !(200...299).contains(response.statusCode) {
            resume(.failure(InstallerFailure.badHTTPStatus(response.statusCode)))
            return
        }

        do {
            let fileManager = FileManager.default
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: location, to: destination)
            resume(.success(destination))
        } catch {
            resume(.failure(error))
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error {
            resume(.failure(error))
        }
    }

    private func resume(_ result: Result<URL, Error>) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()

        guard let continuation else { return }

        switch result {
        case .success(let url):
            continuation.resume(returning: url)
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }
}

private struct InstallerRunner {
    let update: (InstallerUpdate) async -> Void

    func run() async throws -> URL {
        await update(.status("Checking latest version..."))
        let version = await fetchVersion()
        if let version, !version.isEmpty {
            await update(.status("Downloading version \(version)..."))
        } else {
            await update(.status("Downloading partyparty..."))
        }

        let fileManager = FileManager.default
        let tempRoot = fileManager.temporaryDirectory
            .appendingPathComponent("InstallPartyparty-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer {
            try? fileManager.removeItem(at: tempRoot)
        }

        let downloadedZip = tempRoot.appendingPathComponent("partyparty.zip")
        let downloader = DownloadDelegate(destination: downloadedZip) { fraction in
            Task {
                await update(.progress(fraction))
            }
        }
        _ = try await downloader.download(from: payloadURL)

        await update(.progress(nil))
        await update(.status("Expanding partyparty..."))
        let extractDir = tempRoot.appendingPathComponent("expanded", isDirectory: true)
        try fileManager.createDirectory(at: extractDir, withIntermediateDirectories: true)
        try await Self.runProcess("/usr/bin/ditto", ["-x", "-k", downloadedZip.path, extractDir.path])

        let extractedApp = try locateExtractedApp(in: extractDir)

        await update(.status("Verifying partyparty..."))
        try await Self.runProcess("/usr/bin/codesign", ["--verify", "--strict", extractedApp.path])
        try await Self.runProcess("/usr/sbin/spctl", ["-a", "-t", "exec", extractedApp.path])

        await update(.status("Installing to Applications..."))
        let installedApp = try await installApp(extractedApp)

        await update(.status("Preparing first launch..."))
        try await Self.runProcess("/usr/bin/xattr", ["-dr", "com.apple.quarantine", installedApp.path])

        return installedApp
    }

    private func fetchVersion() async -> String? {
        do {
            var request = URLRequest(url: stateURL)
            request.timeoutInterval = 8
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse,
               !(200...299).contains(http.statusCode) {
                fputs("state.json returned HTTP \(http.statusCode)\n", stderr)
                return nil
            }
            return try JSONDecoder().decode(ReleaseState.self, from: data).appVersion
        } catch {
            fputs("Could not fetch release state: \(error)\n", stderr)
            return nil
        }
    }

    private func locateExtractedApp(in directory: URL) throws -> URL {
        let contents = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        for item in contents {
            if item.lastPathComponent == "partyparty.app" {
                return item
            }
        }

        throw InstallerFailure.missingDownloadedApp
    }

    private func installApp(_ sourceApp: URL) async throws -> URL {
        try await Task.detached {
            let fileManager = FileManager.default
            let applicationsDir = fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Applications", isDirectory: true)
            let targetApp = applicationsDir.appendingPathComponent("partyparty.app", isDirectory: true)

            try fileManager.createDirectory(at: applicationsDir, withIntermediateDirectories: true)

            if fileManager.fileExists(atPath: targetApp.path) {
                try fileManager.removeItem(at: targetApp)
            }

            do {
                try fileManager.moveItem(at: sourceApp, to: targetApp)
            } catch {
                fputs("Move failed, falling back to ditto: \(error)\n", stderr)
                if fileManager.fileExists(atPath: targetApp.path) {
                    try fileManager.removeItem(at: targetApp)
                }
                try await Self.runProcess("/usr/bin/ditto", [sourceApp.path, targetApp.path])
                try? fileManager.removeItem(at: sourceApp)
            }

            return targetApp
        }.value
    }

    private static func runProcess(_ executable: String, _ arguments: [String]) async throws {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments

            let output = Pipe()
            process.standardOutput = output
            process.standardError = output

            try process.run()
            process.waitUntilExit()

            let data = output.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""

            guard process.terminationStatus == 0 else {
                throw InstallerFailure.commandFailed(
                    URL(fileURLWithPath: executable).lastPathComponent,
                    process.terminationStatus,
                    text
                )
            }
        }.value
    }
}

private final class InstallerAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var progressIndicator: NSProgressIndicator!
    private var buttonStack: NSStackView!
    private var tryAgainButton: NSButton!
    private var manualButton: NSButton!
    private var installTask: Task<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
        startInstall()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func windowWillClose(_ notification: Notification) {
        installTask?.cancel()
        NSApp.terminate(nil)
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 180),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Install partyparty"
        window.isReleasedWhenClosed = false
        window.center()
        window.delegate = self

        let content = NSView()
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        window.contentView = content

        let iconView = NSImageView()
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.image = NSImage(named: "AppIcon") ?? NSImage(named: NSImage.applicationIconName)
        iconView.imageScaling = .scaleProportionallyUpOrDown

        let titleLabel = NSTextField(labelWithString: "Install partyparty")
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        titleLabel.textColor = .labelColor

        statusLabel = NSTextField(labelWithString: "Starting installer...")
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 13)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 2

        progressIndicator = NSProgressIndicator()
        progressIndicator.translatesAutoresizingMaskIntoConstraints = false
        progressIndicator.style = .bar
        progressIndicator.controlSize = .regular
        progressIndicator.isIndeterminate = false
        progressIndicator.minValue = 0
        progressIndicator.maxValue = 1
        progressIndicator.doubleValue = 0

        manualButton = NSButton(title: "Download manually", target: self, action: #selector(openManualDownload))
        manualButton.bezelStyle = .rounded

        tryAgainButton = NSButton(title: "Try again", target: self, action: #selector(tryAgain))
        tryAgainButton.bezelStyle = .rounded
        tryAgainButton.keyEquivalent = "\r"

        buttonStack = NSStackView(views: [manualButton, tryAgainButton])
        buttonStack.translatesAutoresizingMaskIntoConstraints = false
        buttonStack.orientation = .horizontal
        buttonStack.alignment = .centerY
        buttonStack.spacing = 8
        buttonStack.isHidden = true

        let textStack = NSStackView(views: [titleLabel, statusLabel, progressIndicator, buttonStack])
        textStack.translatesAutoresizingMaskIntoConstraints = false
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 10

        content.addSubview(iconView)
        content.addSubview(textStack)

        NSLayoutConstraint.activate([
            iconView.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            iconView.topAnchor.constraint(equalTo: content.topAnchor, constant: 34),
            iconView.widthAnchor.constraint(equalToConstant: 64),
            iconView.heightAnchor.constraint(equalToConstant: 64),

            textStack.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 22),
            textStack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            textStack.topAnchor.constraint(equalTo: content.topAnchor, constant: 30),

            statusLabel.widthAnchor.constraint(equalTo: textStack.widthAnchor),
            progressIndicator.widthAnchor.constraint(equalTo: textStack.widthAnchor),
            progressIndicator.heightAnchor.constraint(equalToConstant: 12),
            buttonStack.trailingAnchor.constraint(equalTo: textStack.trailingAnchor)
        ])

        window.makeKeyAndOrderFront(nil)
    }

    private func startInstall() {
        installTask?.cancel()
        buttonStack.isHidden = true
        progressIndicator.isHidden = false
        setProgress(0)
        setStatus("Checking latest version...")

        let runner = InstallerRunner { [weak self] update in
            await self?.apply(update)
        }

        installTask = Task {
            do {
                let installedApp = try await runner.run()
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.setProgress(1)
                    self.setStatus("Installed — launching partyparty...")
                    NSWorkspace.shared.open(installedApp)
                }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await MainActor.run {
                    NSApp.terminate(nil)
                }
            } catch {
                guard !Task.isCancelled else { return }
                fputs("Installer failed: \(error)\n", stderr)
                await MainActor.run {
                    self.setProgress(0)
                    let reason = (error as NSError).localizedDescription
                    self.setStatus("Could not install partyparty. \(reason)")
                    self.buttonStack.isHidden = false
                }
            }
        }
    }

    private func setStatus(_ message: String) {
        statusLabel.stringValue = message
    }

    @MainActor
    private func apply(_ update: InstallerUpdate) {
        switch update {
        case .status(let message):
            setStatus(message)
        case .progress(let fraction):
            setProgress(fraction)
        }
    }

    private func setProgress(_ fraction: Double?) {
        if let fraction {
            if progressIndicator.isIndeterminate {
                progressIndicator.stopAnimation(nil)
                progressIndicator.isIndeterminate = false
            }
            progressIndicator.doubleValue = max(0, min(1, fraction))
        } else {
            if !progressIndicator.isIndeterminate {
                progressIndicator.isIndeterminate = true
                progressIndicator.startAnimation(nil)
            }
        }
    }

    @objc private func openManualDownload() {
        NSWorkspace.shared.open(manualDownloadURL)
    }

    @objc private func tryAgain() {
        startInstall()
    }
}

private let application = NSApplication.shared
private let delegate = InstallerAppDelegate()
application.delegate = delegate
application.run()
