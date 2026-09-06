"""One-time, integrity-checked import of the previously delivered Forma sources."""
from pathlib import Path, PurePosixPath
import hashlib
import io
import tarfile

ROOT = Path.cwd()
EXPECTED = "d4f3f3bb4c6b8827d6802894d03463ba7664fa9acdee06a69c688d738b5e9454"
FILES = {
    ".gitignore", "BUILD.txt", "LICENSE", "README.md", "build.mjs",
    "examples/roam.forma", "forma.html", "index.html", "package.json",
    "src/app.js", "src/document.js", "src/geometry.js", "src/icons.js",
    "src/io.js", "src/renderer.js", "style.css", "tests/browser-results.json",
    "tests/browser-smoke.py", "tests/geometry.test.js", "tests/renderer.test.js",
    "tests/unit-results.tap",
}
parts = [ROOT / ".bootstrap" / f"source.part-{i:02d}" for i in range(11)]
data = b"".join(part.read_bytes() for part in parts)
if len(data) != 81152 or hashlib.sha256(data).hexdigest() != EXPECTED:
    raise SystemExit("Source archive integrity check failed; no files imported")
with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
    members = archive.getmembers()
    if len(members) != len(FILES) or {m.name for m in members} != FILES:
        raise SystemExit("Unexpected archive file manifest")
    for member in members:
        path = PurePosixPath(member.name)
        if not member.isfile() or path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"Unsafe archive entry: {member.name}")
        if member.size > 2_000_000:
            raise SystemExit(f"Archive member exceeds import limit: {member.name}")
    for member in members:
        target = ROOT / member.name
        target.parent.mkdir(parents=True, exist_ok=True)
        stream = archive.extractfile(member)
        if stream is None:
            raise SystemExit(f"Cannot read {member.name}")
        target.write_bytes(stream.read())
        print(f"Restored {member.name}: {member.size} bytes")
print(f"Verified {len(members)} original files; archive SHA-256 {EXPECTED}")
