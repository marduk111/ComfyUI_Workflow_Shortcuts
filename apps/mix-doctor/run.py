"""Mix Doctor — song health check.

Wraps the Suno Bridge analysis engine (a separate local project) and returns
a compact JSON verdict: BPM, key, loudness, mix character, and any detected
problems with severity + plain-English explanations.

Usage (via the studio CLI):
  node studio/studio.js app_run id=mix-doctor file="song.wav"
  node studio/studio.js app_run id=mix-doctor file="C:\\path\\to\\song.mp3" duration=60

Args received as JSON on argv[1]:
  file      - absolute path, or a filename that lives in ComfyUI's input folder
  duration  - optional, analyze only the first N seconds (faster)
  full      - optional, include the entire report in the response (big)
"""
import sys
import os
import json
import tempfile

# The Suno Bridge engine is a separate project on the Desktop. Allow override
# via SUNO_BRIDGE env var so it can be moved without breaking this app.
SUNO_BRIDGE = os.environ.get(
    "SUNO_BRIDGE",
    os.path.expanduser(r"~\OneDrive\Desktop\suno-bridge"),
)
COMFY_INPUT = os.environ.get(
    "COMFY_INPUT",
    r"D:\ComfyUI_windows_portable\ComfyUI\input",
)


def resolve_file(name):
    """Accept an absolute path or a bare filename in ComfyUI's input folder."""
    if not name:
        return None
    if os.path.isabs(name) and os.path.isfile(name):
        return name
    candidate = os.path.join(COMFY_INPUT, name)
    if os.path.isfile(candidate):
        return candidate
    if os.path.isfile(name):
        return os.path.abspath(name)
    return None


def main():
    args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}

    if not os.path.isdir(SUNO_BRIDGE):
        print(json.dumps({
            "error": "Suno Bridge engine not found",
            "hint": f"Expected it at {SUNO_BRIDGE}. Set SUNO_BRIDGE env var if it moved.",
        }))
        return

    audio = resolve_file(args.get("file") or args.get("filename"))
    if not audio:
        print(json.dumps({
            "error": "No audio file found",
            "hint": 'Pass file="song.wav" (ComfyUI input) or file="C:\\\\full\\\\path\\\\song.mp3"',
        }))
        return

    sys.path.insert(0, SUNO_BRIDGE)
    from engine.analyzer import analyze_audio  # noqa: E402

    duration = args.get("duration")
    duration = int(duration) if duration else None

    # Reports are written into a temp dir so the song's folder stays clean.
    with tempfile.TemporaryDirectory(prefix="mix-doctor-") as tmp:
        report = analyze_audio(
            audio,
            output_dir=tmp,
            run_stems=False,  # Demucs is slow; the studio has stem workflows for that
            duration=duration,
        )

    if report.get("error"):
        print(json.dumps({"error": report["error"]}))
        return

    spectral = report.get("spectral", {})
    problems = spectral.get("problems", [])
    result = {
        "file": report["meta"]["file_name"],
        "duration_sec": report["meta"]["duration_sec"],
        "summary": report.get("summary", ""),
        "bpm": report.get("tempo", {}).get("bpm"),
        "key": f"{report.get('harmonic', {}).get('key')} {report.get('harmonic', {}).get('scale')}",
        "key_confidence": report.get("harmonic", {}).get("key_confidence"),
        "lufs": report.get("loudness", {}).get("integrated_lufs"),
        "true_peak_dbtp": report.get("loudness", {}).get("true_peak_dbtp"),
        "problems": problems,
        "problem_count": len(problems),
        "warnings": len([p for p in problems if p.get("severity") == "warning"]),
    }
    if args.get("full"):
        result["report"] = report

    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
