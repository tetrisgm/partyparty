import AppKit
import Foundation
import SQLite3

/// The DJ's Shazam library, read from where macOS actually keeps it.
///
/// `SHLibrary.default.items` is the API for this and it returns nothing. Not an
/// error - an empty array, on a Mac holding 898 matches. Proven on 2026-08-10
/// against a build signed with a real Mac Development profile, unsandboxed, and
/// retried for five seconds: the framework accepts the app as a library client
/// (it creates a CloudKit zone subscription under
/// `~/Library/Caches/com.apple.shazamlibrary.cloud/fm.partyparty.app/`) and
/// hands back an empty library. The App ID carries the SHAZAM_KIT capability,
/// but no provisioning profile generated from it grants a ShazamKit
/// entitlement, and a binary that claims one is killed at launch.
///
/// The data is right there regardless. `shazamd` keeps it in a Core Data store
/// that already holds everything Shazamed on the phone - sync works, and always
/// did. So this reads the store.
///
/// It is a private path with no stability promise, which is a real cost and the
/// owner's decision (2026-08-10): "you were able to tell me what I've
/// recognized from Shazam recently anyway, so that means you have access to the
/// information and that's all we need". If a future macOS moves or reshapes it,
/// this returns nothing and the console says the library is empty - the same
/// honest dead end as today, and nothing else in the app notices.
enum ShazamStore {
    /// Where the daemon keeps it, in the REAL home rather than our container.
    static let folder = "Library/Application Support/com.apple.shazamd"
    static let file = "ShazamLibrary.sqlite"

    /// The real home directory. `NSHomeDirectory()` is the sandbox container,
    /// which is precisely not where this lives.
    static var realHome: String {
        // getpwuid is not redirected by the sandbox the way NSHomeDirectory is.
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            return String(cString: dir)
        }
        return NSHomeDirectory()
    }

    static var folderURL: URL {
        URL(fileURLWithPath: realHome).appendingPathComponent(folder)
    }

    private static let bookmarkKey = "shazamStoreBookmark"

    // MARK: access

    /// Whether the store can be read right now, without asking anybody.
    ///
    /// Two ways it can be true: this build is not sandboxed (the standalone
    /// lane), or the DJ has already pointed us at the folder once and we kept a
    /// security-scoped bookmark.
    static func readable() -> Bool {
        if FileManager.default.isReadableFile(atPath: folderURL.appendingPathComponent(file).path) {
            return true
        }
        guard let url = bookmarked() else { return false }
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        return FileManager.default.isReadableFile(atPath: url.appendingPathComponent(file).path)
    }

    private static func bookmarked() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: .withSecurityScope,
                                 relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        return url
    }

    /// Ask the DJ to point at the folder, once.
    ///
    /// The sandbox has exactly one sanctioned way to read a file the app was
    /// not given: the person chooses it. `files.user-selected.read-only` is
    /// already in the entitlements. The panel opens ON the right folder, so
    /// this is one click and not an errand into a hidden directory - and the
    /// bookmark means it is asked once, ever.
    @MainActor
    static func requestAccess() -> Bool {
        if readable() { return true }
        let panel = NSOpenPanel()
        panel.directoryURL = folderURL
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Allow"
        panel.message = "PartyParty needs to read your Shazam library to add your "
            + "own Shazams to the parties they happened at. It is only ever read."
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        if let data = try? url.bookmarkData(options: .withSecurityScope,
                                            includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(data, forKey: bookmarkKey)
        }
        return true
    }

    // MARK: reading

    /// Every match in the library, oldest first, as items the server can file.
    ///
    /// The store is live and in WAL mode, so it is copied into our own space
    /// and read there. Opening the original read-only would need to write a
    /// `-shm` beside it, which is exactly what read-only access does not allow,
    /// and `immutable=1` would skip the write-ahead log and silently miss the
    /// most recent Shazams - which are the ones a DJ is asking about.
    static func read() -> [ShazamLibrary.Item] {
        var base = folderURL
        var scoped = false
        if !FileManager.default.isReadableFile(atPath: base.appendingPathComponent(file).path),
           let saved = bookmarked() {
            base = saved
            scoped = saved.startAccessingSecurityScopedResource()
        }
        defer { if scoped { base.stopAccessingSecurityScopedResource() } }

        let work = FileManager.default.temporaryDirectory
            .appendingPathComponent("shazam-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: work) }
        guard (try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true))
            != nil else { return [] }
        for name in [file, file + "-wal", file + "-shm"] {
            try? FileManager.default.copyItem(at: base.appendingPathComponent(name),
                                              to: work.appendingPathComponent(name))
        }
        let copy = work.appendingPathComponent(file)
        guard FileManager.default.fileExists(atPath: copy.path) else {
            NSLog("PartyParty: no Shazam library at \(base.path)")
            return []
        }
        return rows(in: copy)
    }

    private static func rows(in db: URL) -> [ShazamLibrary.Item] {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(db.path, &handle, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            NSLog("PartyParty: cannot open the Shazam library copy")
            sqlite3_close(handle)
            return []
        }
        defer { sqlite3_close(handle) }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        var out: [ShazamLibrary.Item] = []
        var statement: OpaquePointer?
        // ZDATE is Core Data's epoch - seconds since 2001-01-01 - so it becomes
        // a Date through timeIntervalSinceReferenceDate rather than 1970.
        let sql = "SELECT ZTITLE, ZSUBTITLE, ZDATE, ZSHAZAMKEY, ZARTWORKURL FROM ZSHTRACKMO "
            + "WHERE ZTITLE IS NOT NULL AND ZDATE IS NOT NULL ORDER BY ZDATE"
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
            NSLog("PartyParty: Shazam library has an unexpected shape")
            return []
        }
        defer { sqlite3_finalize(statement) }
        while sqlite3_step(statement) == SQLITE_ROW {
            func text(_ column: Int32) -> String {
                guard let raw = sqlite3_column_text(statement, column) else { return "" }
                return String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let title = text(0)
            if title.isEmpty { continue }
            let when = Date(timeIntervalSinceReferenceDate: sqlite3_column_double(statement, 2))
            out.append(ShazamLibrary.Item(
                title: title,
                artist: text(1),
                shazamID: text(3),
                artworkURL: text(4),
                atMs: Int64(when.timeIntervalSince1970 * 1000),
                night: ShazamLibrary.night(of: when, calendar: calendar)))
        }
        return out
    }
}
