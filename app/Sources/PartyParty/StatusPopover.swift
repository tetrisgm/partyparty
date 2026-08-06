import AppKit
import CoreImage.CIFilterBuiltins

/// The menu-bar window: the guest QR front and center, the listener count under
/// it, one Go live / Stop broadcast toggle that behaves exactly like the
/// console button, and Open PartyParty. No status prose - the icon carries the
/// glanceable state and the console owns the detail.
final class StatusPopoverController: NSViewController {
    var onToggleBroadcast: () -> Void = {}
    var onOpenApp: () -> Void = {}
    var onQuit: () -> Void = {}

    private let qrView = NSImageView()
    private let qrPending = NSTextField(labelWithString: "Getting the party link…")
    private let listenersLabel = NSTextField(labelWithString: "")
    private let toggleButton = NSButton(title: "Go live", target: nil, action: nil)
    private let openButton = NSButton(title: "Open PartyParty", target: nil, action: nil)
    private let quitButton = NSButton(title: "Quit", target: nil, action: nil)
    private var lastQRURL = ""
    /// Set by the app so the popover can fetch the DJ avatar for the QR badge.
    var serverPort = 8000
    private var avatarImage: NSImage?
    private var avatarFetchedAt = Date.distantPast

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 248, height: 0))

        qrView.imageScaling = .scaleProportionallyUpOrDown
        qrView.wantsLayer = true
        qrView.layer?.backgroundColor = NSColor.white.cgColor
        qrView.layer?.cornerRadius = 10

        qrPending.font = .systemFont(ofSize: 12)
        qrPending.textColor = .secondaryLabelColor
        qrPending.alignment = .center

        listenersLabel.font = .systemFont(ofSize: 12, weight: .medium)
        listenersLabel.textColor = .secondaryLabelColor
        listenersLabel.alignment = .center

        toggleButton.bezelStyle = .flexiblePush
        toggleButton.controlSize = .large
        toggleButton.keyEquivalent = "\r"
        toggleButton.target = self
        toggleButton.action = #selector(toggleTapped)

        openButton.bezelStyle = .flexiblePush
        openButton.controlSize = .large
        openButton.target = self
        openButton.action = #selector(openTapped)

        quitButton.isBordered = false
        quitButton.font = .systemFont(ofSize: 11)
        quitButton.contentTintColor = .tertiaryLabelColor
        quitButton.target = self
        quitButton.action = #selector(quitTapped)

        let stack = NSStackView(views: [qrView, qrPending, listenersLabel, toggleButton, openButton, quitButton])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 10, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: root.topAnchor),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            qrView.widthAnchor.constraint(equalToConstant: 200),
            qrView.heightAnchor.constraint(equalToConstant: 200),
            toggleButton.widthAnchor.constraint(equalToConstant: 216),
            openButton.widthAnchor.constraint(equalToConstant: 216),
        ])
        view = root
    }

    /// The DJ photo (or nothing, drawing the neutral silhouette) rides the QR
    /// center. Fetched from the local server, refreshed lazily; a change
    /// re-renders the QR on the next pass.
    private func refreshAvatarIfStale() {
        guard Date().timeIntervalSince(avatarFetchedAt) > 60 else { return }
        avatarFetchedAt = Date()
        guard let url = URL(string: "http://127.0.0.1:\(serverPort)/dj-avatar") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let image = ok ? data.flatMap(NSImage.init(data:)) : nil
            DispatchQueue.main.async {
                guard let self else { return }
                self.avatarImage = image
                self.lastQRURL = "" // re-badge on the next render
            }
        }.resume()
    }

    @objc private func toggleTapped() { onToggleBroadcast() }
    @objc private func openTapped() { onOpenApp() }
    @objc private func quitTapped() { onQuit() }

    func render(_ s: ServerStatus) {
        refreshAvatarIfStale()
        let hasQR = !s.guestURL.isEmpty
        qrView.isHidden = !hasQR
        qrPending.isHidden = hasQR
        if hasQR && s.guestURL != lastQRURL {
            lastQRURL = s.guestURL
            qrView.image = Self.qrImage(for: s.guestURL, badge: avatarImage)
        }

        switch s.listeners {
        case 0:  listenersLabel.stringValue = "Nobody listening yet"
        case 1:  listenersLabel.stringValue = "1 listener"
        default: listenersLabel.stringValue = "\(s.listeners) listeners"
        }

        let broadcasting = s.state == "live" || s.state == "starting"
        toggleButton.title = broadcasting ? "Stop broadcast" : "Go live"
        toggleButton.bezelColor = broadcasting ? nil : NSColor(srgbRed: 1.0, green: 0.176, blue: 0.435, alpha: 1) // #ff2d6f
        toggleButton.contentTintColor = broadcasting ? nil : .white
    }

    /// Crisp QR at 200pt: render the CIQRCodeGenerator output at its tiny module
    /// size, then scale with nearest-neighbor so modules stay square. The
    /// generator includes the standard quiet zone; the white layer rounds it.
    private static func qrImage(for text: String, badge: NSImage?) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "H"
        guard let raw = filter.outputImage else { return nil }
        // Brand pink modules, matching the console QR.
        let colored = CIFilter.falseColor()
        colored.inputImage = raw
        colored.color0 = CIColor(red: 1.0, green: 0.176, blue: 0.435)
        colored.color1 = CIColor(red: 1, green: 1, blue: 1)
        guard let output = colored.outputImage else { return nil }
        let scale = (200.0 * 2.0) / output.extent.width // 2x backing for Retina
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext()
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        let image = NSImage(cgImage: cg, size: NSSize(width: 200, height: 200))
        // Center badge: the DJ photo when set, the neutral silhouette
        // otherwise - matching the console and guest-page QRs. Correction
        // level H absorbs the covered modules.
        let size: CGFloat = 200
        let dia = size * 0.24
        let pad = size * 0.012
        let composed = NSImage(size: NSSize(width: size, height: size))
        composed.lockFocus()
        image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
        let center = NSPoint(x: size / 2, y: size / 2)
        let padRect = NSRect(x: center.x - dia / 2 - pad, y: center.y - dia / 2 - pad,
                             width: dia + pad * 2, height: dia + pad * 2)
        NSColor.white.setFill()
        NSBezierPath(ovalIn: padRect).fill()
        let holeRect = NSRect(x: center.x - dia / 2, y: center.y - dia / 2, width: dia, height: dia)
        let clip = NSBezierPath(ovalIn: holeRect)
        NSGraphicsContext.saveGraphicsState()
        clip.addClip()
        if let badge {
            badge.draw(in: holeRect, from: .zero, operation: .sourceOver, fraction: 1)
        } else {
            NSColor(srgbRed: 0.89, green: 0.89, blue: 0.91, alpha: 1).setFill()
            NSBezierPath(ovalIn: holeRect).fill()
            NSColor(srgbRed: 0.66, green: 0.66, blue: 0.70, alpha: 1).setFill()
            let headD = dia * 0.32
            NSBezierPath(ovalIn: NSRect(x: center.x - headD / 2, y: center.y + dia * 0.02,
                                        width: headD, height: headD)).fill()
            let shoulders = NSBezierPath()
            shoulders.appendArc(withCenter: NSPoint(x: center.x, y: center.y - dia * 0.42),
                                radius: dia * 0.30, startAngle: 0, endAngle: 180)
            shoulders.close()
            shoulders.fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        composed.unlockFocus()
        return composed
    }
}
