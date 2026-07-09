#!/usr/bin/env python3
import argparse
import plistlib
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle"
EXPECTED_FEED_URL = "https://party.ramine.net/appcast.xml"


def fail(message):
    print(f"release verification failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_plist(app_path):
    info = Path(app_path) / "Contents" / "Info.plist"
    if not info.exists():
        fail(f"Info.plist not found at {info}")
    with info.open("rb") as f:
        data = plistlib.load(f)
    version = str(data.get("CFBundleShortVersionString", ""))
    build = str(data.get("CFBundleVersion", ""))
    feed = str(data.get("SUFeedURL", ""))
    return {"path": Path(app_path), "version": version, "build": build, "feed": feed}


def parse_appcast(data, source):
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        fail(f"{source} is not valid XML: {exc}")

    item = root.find("./channel/item")
    if item is None:
        fail(f"{source} has no channel/item entry")
    enclosure = item.find("enclosure")
    if enclosure is None:
        fail(f"{source} item has no enclosure")

    return {
        "short_version": item.findtext(f"{{{SPARKLE_NS}}}shortVersionString", ""),
        "build": item.findtext(f"{{{SPARKLE_NS}}}version", ""),
        "url": enclosure.get("url", ""),
        "length": enclosure.get("length", ""),
        "signature": enclosure.get(f"{{{SPARKLE_NS}}}edSignature", ""),
    }


def verify_app(info, expected_version, expected_build):
    if info["version"] != expected_version:
        fail(f"{info['path']} version is {info['version']}, expected {expected_version}")
    if info["build"] != expected_build:
        fail(f"{info['path']} build is {info['build']}, expected {expected_build}")
    if info["feed"] != EXPECTED_FEED_URL:
        fail(f"{info['path']} SUFeedURL is {info['feed']}, expected {EXPECTED_FEED_URL}")
    print(f"app bundle: {info['version']} build {info['build']} feed {info['feed']}")


def verify_appcast(meta, source, expected_version, expected_build, expected_zip_url, zip_path=None):
    if meta["short_version"] != expected_version:
        fail(f"{source} shortVersionString is {meta['short_version']}, expected {expected_version}")
    if meta["build"] != expected_build:
        fail(f"{source} sparkle:version is {meta['build']}, expected {expected_build}")
    if meta["url"] != expected_zip_url:
        fail(f"{source} enclosure URL is {meta['url']}, expected {expected_zip_url}")
    if not meta["signature"]:
        fail(f"{source} enclosure is missing sparkle:edSignature")

    if zip_path is not None:
        z = Path(zip_path)
        if not z.exists():
            fail(f"zip artifact not found at {z}")
        if meta["length"]:
            actual = z.stat().st_size
            try:
                expected_length = int(meta["length"])
            except ValueError:
                fail(f"{source} enclosure length is not numeric: {meta['length']}")
            if actual != expected_length:
                fail(f"{source} enclosure length is {expected_length}, local zip is {actual}")

    print(
        f"{source}: shortVersionString {meta['short_version']} "
        f"sparkle:version {meta['build']} edSignature present"
    )
    print(f"public zip URL: {meta['url']}")


def find_installed_app(explicit):
    if explicit == "none":
        return None
    if explicit and explicit != "auto":
        path = Path(explicit).expanduser()
        return path if path.exists() else None
    for candidate in (
        Path.home() / "Applications" / "partyparty.app",
        Path("/Applications/partyparty.app"),
    ):
        if candidate.exists():
            return candidate
    return None


def installed_build(args):
    if args.installed_build:
        print(f"installed app: build {args.installed_build} (override)")
        return args.installed_build

    installed = find_installed_app(args.installed_app)
    if installed is None:
        print("installed app: not found; skipping installed-build comparison")
        return None

    info = read_plist(installed)
    print(f"installed app: {info['path']} {info['version']} build {info['build']}")
    return info["build"]


def require_newer(appcast_build, current_build):
    if current_build is None:
        return
    try:
        appcast_i = int(appcast_build)
        current_i = int(current_build)
    except ValueError:
        fail(f"cannot compare appcast build {appcast_build} with installed build {current_build}")
    if appcast_i <= current_i:
        fail(f"appcast build {appcast_i} is not newer than installed build {current_i}")
    print(f"update comparison: appcast build {appcast_i} > installed build {current_i}")


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "partyparty-release-verify"})
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status >= 400:
            fail(f"GET {url} returned HTTP {response.status}")
        return response.read()


def http_head(url):
    req = urllib.request.Request(
        url,
        method="HEAD",
        headers={"User-Agent": "partyparty-release-verify"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status >= 400:
            fail(f"HEAD {url} returned HTTP {response.status}")
        print(f"public artifact: {url} HTTP {response.status}")


def main():
    parser = argparse.ArgumentParser(description="Verify partyparty app/appcast release metadata.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--zip", required=True)
    parser.add_argument("--appcast", required=True)
    parser.add_argument("--base-url", default="https://party.ramine.net")
    parser.add_argument("--installed-app", default="auto")
    parser.add_argument("--installed-build", default="")
    parser.add_argument("--require-newer-than-installed", action="store_true")
    parser.add_argument("--public", action="store_true")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    expected_zip_url = f"{base_url}/partyparty-{args.version}.zip"

    app_info = read_plist(args.app)
    verify_app(app_info, args.version, args.build)

    local_appcast = parse_appcast(Path(args.appcast).read_bytes(), "local appcast")
    verify_appcast(local_appcast, "local appcast", args.version, args.build, expected_zip_url, args.zip)

    current_build = installed_build(args)
    if args.require_newer_than_installed:
        require_newer(local_appcast["build"], current_build)

    if args.public:
        public_appcast_url = f"{base_url}/appcast.xml"
        http_head(expected_zip_url)
        public_appcast = parse_appcast(http_get(public_appcast_url), "public appcast")
        verify_appcast(public_appcast, "public appcast", args.version, args.build, expected_zip_url)
        print(f"public feed URL: {public_appcast_url}")


if __name__ == "__main__":
    main()
