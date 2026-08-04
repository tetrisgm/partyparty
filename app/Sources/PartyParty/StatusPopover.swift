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

    @objc private func toggleTapped() { onToggleBroadcast() }
    @objc private func openTapped() { onOpenApp() }
    @objc private func quitTapped() { onQuit() }

    func render(_ s: ServerStatus) {
        let hasQR = !s.guestURL.isEmpty
        qrView.isHidden = !hasQR
        qrPending.isHidden = hasQR
        if hasQR && s.guestURL != lastQRURL {
            lastQRURL = s.guestURL
            qrView.image = Self.qrImage(for: s.guestURL)
        }

        switch s.listeners {
        case 0:  listenersLabel.stringValue = "Nobody listening yet"
        case 1:  listenersLabel.stringValue = "1 listening"
        default: listenersLabel.stringValue = "\(s.listeners) listening"
        }

        let broadcasting = s.state == "live" || s.state == "starting"
        toggleButton.title = broadcasting ? "Stop broadcast" : "Go live"
        toggleButton.bezelColor = broadcasting ? nil : NSColor(srgbRed: 1.0, green: 0.176, blue: 0.435, alpha: 1) // #ff2d6f
        toggleButton.contentTintColor = broadcasting ? nil : .white
    }

    /// Crisp QR at 200pt: render the CIQRCodeGenerator output at its tiny module
    /// size, then scale with nearest-neighbor so modules stay square. The
    /// generator includes the standard quiet zone; the white layer rounds it.
    private static func qrImage(for text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scale = (200.0 * 2.0) / output.extent.width // 2x backing for Retina
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext()
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        let image = NSImage(cgImage: cg, size: NSSize(width: 200, height: 200))
        return image
    }
}
