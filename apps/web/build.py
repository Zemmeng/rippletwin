"""Bundle src/ into a single-file web page.

Usage: python3 apps/web/build.py (works from any directory)
Outputs:
  public/index.html     the full HTML document, served as-is by apps/site or any static server (committed)
  out/web-artifact.html body-level content only, for publishing as a Claude Artifact (out/ is not committed)
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent
src = root / "src"


def bundle():
    head = (src / "head.html").read_text(encoding="utf-8")
    css = (src / "styles.css").read_text(encoding="utf-8")
    body = (src / "body.html").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8") for p in sorted((src / "js").glob("*.js")))
    js = js.replace("'use strict';\n", "")
    script = "<script>\n'use strict';\n" + js + "\n</script>\n"
    style = "<style>\n" + css + "</style>\n"
    page = (
        '<!doctype html>\n<html lang="en" data-theme="dark">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        + head + style + "</head>\n<body>\n" + body + script + "</body>\n</html>\n"
    )
    return page, head + style + body + script


def write(path, text):
    # Path.write_text(newline=) needs Python 3.10; the python3 that ships with macOS is 3.9
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


if __name__ == "__main__":
    page, artifact = bundle()
    (root / "public").mkdir(exist_ok=True)
    write(root / "public" / "index.html", page)
    (root / "out").mkdir(exist_ok=True)
    write(root / "out" / "web-artifact.html", artifact)
    print(f"public/index.html {len(page.encode('utf-8'))} bytes")
