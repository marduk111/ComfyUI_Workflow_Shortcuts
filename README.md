# AI Studio — a friendly local AI workshop

A double-click studio for Windows that turns plain English into images, videos,
song edits and custom tools — running **entirely on your own PC**. It wraps
[ComfyUI](https://github.com/comfyanonymous/ComfyUI) (the generator),
[opencode](https://opencode.ai) (the chat AI), and optional
[Ollama](https://ollama.com) (offline extras) in one beginner-friendly browser
window with a live, narrated workflow animation.

Nothing is uploaded anywhere. No credit card. Free accounts only, and only for
the few things described in [Accounts](#accounts--what-you-actually-need).

---

## What you need

| Requirement | Details |
|---|---|
| Windows | Windows 10 or 11 (64-bit) |
| NVIDIA graphics card | 6 GB VRAM works (tested on a RTX 3050 6 GB); more is better |
| Disk space | ~15 GB free (ComfyUI 6 GB + models 4 GB + tools) |
| Internet | Only for the one-time install and model downloads |
| Node.js | Installed automatically by the installer if missing |

## Install

**Double-click `INSTALL.bat`.** Answer `y` to each question it asks. It checks
your PC and installs only what's missing:

| Step | What it does | Size / time |
|---|---|---|
| 1. Node.js | The runtime the studio runs on (via winget) | ~80 MB |
| 2. Studio files | Downloads this folder's dependencies | ~1 min |
| 3. opencode | The chat AI (`npm install -g opencode-ai`) | ~50 MB |
| 4. Git | Needed to fetch ComfyUI add-ons | ~60 MB |
| 5. ComfyUI | Official portable build, unpacked to `C:\` | ~6 GB, 10–30 min |
| 6. Add-on packs | Audio stems, pose detection, video export, FramePack | ~5 min |
| 7. AI model | DreamShaper 8 (the image model this studio is tuned for) | ~2 GB |
| 8. Ollama | *Optional* — offline chat models | ~5 min |

You can press `N` to skip anything and re-run `INSTALL.bat` later — it only
ever installs what's missing.

**Manual install (if you prefer):** get Node.js from
[nodejs.org](https://nodejs.org), ComfyUI from
[its releases page](https://github.com/comfyanonymous/ComfyUI/releases)
(download `ComfyUI_windows_portable_nvidia.7z` and unpack it with
[7-Zip](https://7-zip.org) to `C:\` so you end up with
`C:\ComfyUI_windows_portable\ComfyUI\`), then run `INSTALL.bat` to fill in the
rest.

### ComfyUI somewhere else?

That's fine. The studio looks for ComfyUI at `COMFY_ROOT` (environment
variable), then tries `D:\ComfyUI_windows_portable`,
`C:\ComfyUI_windows_portable` and folders next to this one. See
[Advanced configuration](#advanced-configuration).

## First launch

**Double-click `START_STUDIO.bat`.** It starts ComfyUI (a small black window
opens — leave it alone), starts the studio, and opens your browser at
`http://127.0.0.1:7860`. Keep the black window open while you work.

### Sign in the AI once

The chat box is powered by opencode. On a fresh install, open a terminal in
this folder and run:

```
opencode auth login
```

Pick a sign-in method (GitHub is easiest) and finish in the browser. This is
**free** — it gives the studio its chat model. You only ever do this once.

## Accounts — what you actually need

| Account | Needed? | Why | How |
|---|---|---|---|
| **opencode** | **Yes** (one-time) | Powers the chat AI | `opencode auth login` in a terminal, sign in with GitHub |
| **GitHub** | No — optional | Publishing a project as a repo; borrowing code | Free signup at [github.com](https://github.com); the first push opens a sign-in window |
| **Hugging Face** | No — optional | Extra AI models via the `hf` tool | Free signup at [huggingface.co](https://huggingface.co) → Settings → Access Tokens → create a read token → `hf auth login` |
| **CivitAI** | No — optional | Community image models | Free signup at [civitai.com](https://civitai.com), download a `.safetensors` into `ComfyUI\models\checkpoints` |
| **Ollama** | No account at all | Offline extras | `ollama pull llama3.2` after installing |

Everyday generating needs **no accounts at all** once installed: models are on
your disk, the GPU is yours, and nothing leaves the machine.

## Using the studio

### What you'll see

- **Chat** (left) — type what you want in plain English, e.g.
  *"make an image of a cozy cabin in a snowy forest"*, or
  *"turn my photo into a video of me dancing"*. The AI's thinking appears live.
- **Workflow** (middle) — the pipeline animates as it runs: each box lights up,
  a stage counter ("4/9") and a plain-English explanation ("Painting the image
  with DPM++ 2M — step 12 of 24 done") tell you exactly what is happening, and
  errors are translated into human words.
- **Results / Assets / Steps** (right) — every image and video produced, newest
  first. **Assets** holds photos you drag in.

### Typical request

1. Drag a photo into the window (only needed for photo→image or photo→video).
2. Type what you want and press Send.
3. Watch it work, then open the **Results** tab.

### Projects (folders for ongoing work)

When something is more than a one-off — an album cover, a channel's videos, a logo
you keep revisiting — give it a **project**.

- Open the **Projects** tab (right side) and press **+ New project**.
- Pick a name and a one-line description. That creates a normal folder on your
  laptop at `projects/<your project>/` containing:
  - `assets/` — photos you drop in (uploaded files land here automatically
    while that project is active)
  - `results/` — everything the AI generated for it
  - `workflows/` — any generator settings tuned for it
  - `project.json` and a `README.md` that describe it
- The name of the active project shows as a pill next to **Conversation** at the
  top-left. Click it any time to switch projects, or click a project card again
  to work with no project.
- The AI is told which project folder it is working in, so it files its own
  results in the right place without you having to explain it.
- **Publish** on a project card saves a snapshot of that project on your laptop
  (it becomes its own version-controlled folder). It then asks whether to also
  upload it to your GitHub account as a **private** repository — press Cancel
  to keep it local.

### Songs and stems

Sound works the same way as images and video — drag an MP3 or WAV into the window
and ask for it in plain English:

- *"split this song into stems"* → vocals, drums, bass and "other", as four files
- *"give me the acapella"* / *"make a karaoke version"*
- *"make the singing louder than the instruments"*
- *"warm it up"*, *"take the harshness out"*, *"make it louder"*
- *"cut out the first 12 seconds"*, *"loop the chorus"*, *"slow it down"*

The separated stems come out as separate MP3s under `output\audio\`, so you can drag
them straight into any music program afterwards. Anything you drop in while a project
is active is filed into that project too.

Under the hood this uses the free open-source **Hybrid Demucs** stem separator
(~320 MB, downloaded once and cached) running on your own graphics card — nothing
is uploaded anywhere.

### Plugins — audio effects you can play

The studio can also turn a **plugin definition** (a small JSON file describing
sliders and a signal chain) into a working audio effect that runs in your browser.
Click **Plugins** in the top bar to open the host: pick an effect, press Play, and
move the sliders while the song loops. **Export WAV** gives you the processed file.

Before anything is built it is *proven* first: the studio renders the effect over a
real song and checks that muting the effect is an exact copy of the original and that
nothing blows up at the most extreme settings. Only then does it become playable.

Definitions live in `plugins/` (currently `Stem_Instrument_Repair.json`, a stem
cleanup effect with 7 controls). The AI can write new ones on request — describe the
sound you want and it can produce a definition, test it, and build it.

### Apps — tools the AI builds for you

Click **Apps ▾** in the top bar to see everything the studio can do. Built-in pages
(Plugins) sit next to anything the AI has built for you. **＋ Ask the AI to build a
new app** drops a prompt into the chat — describe the task and the AI will build it.

The AI draws from a pool of resources it can check at any time:

| Resource | What it gives the AI |
|---|---|
| ComfyUI | Image, video and audio generation on your GPU |
| Ollama | Local language models (including the speech model for transcription) |
| Hermes | A strong local reasoning model for planning and code |
| Hugging Face | Thousands of ready-made AI models to download |
| GitHub | Public repos to borrow working code from |
| ffmpeg / Python | Media conversion (the `media` command) and scripting |
| Web bridge | A real browser (your logged-in Edge) + saved API recipes from sites |
| opencode | The AI itself — the brain talking to you in the chat |

So when you say "I need a tool that does X", the AI can search Hugging Face for a
model, clone a GitHub repo for the glue code, wire it to a local Ollama brain, and
register the result as a new app — all on this machine, nothing uploaded. **It only
downloads models or clones repos after you ask for it** (you'll see a "confirm"
message first). Two examples already exist: **Song Stats** (reads a WAV and reports
loudness) and **Track Namer** (asks a local model to name your track from a mood).

### Websites as tools

The AI can open a real browser window (your Edge, with your logins) and use websites
for you — look things up, read pages, click around. Better still, it can **learn a
site's own API**: watch the calls a site makes when you press a button, save that as
a recipe (a "connector"), and call it directly next time — no browser, no clicking.
It also wraps local analysis tools: **Mix Doctor** checks a song's BPM, key, loudness
and mix problems by wrapping the Suno Bridge analyzer from your Desktop.

**Safety:** the browser is your real session. The AI will not submit purchases, delete
things, or post publicly unless you explicitly ask for that exact action.

## Models — what to download and where

Everything goes into `ComfyUI\models\<folder>` inside your ComfyUI install
(e.g. `C:\ComfyUI_windows_portable\ComfyUI\models\`).

| Model | Needed for | Where to get it | Put it in |
|---|---|---|---|
| `dreamshaper_8.safetensors` | Images (installed by `INSTALL.bat`) | `hf download KatarLegacy/dreamshaper_8 dreamshaper_8.safetensors --local-dir <models>\checkpoints` or CivitAI | `models\checkpoints` |
| `ltxv-2b-0.9.8-distilled-fp8.safetensors` | Fast photo→video | `hf download Lightricks/LTX-Video ltxv-2b-0.9.8-distilled-fp8.safetensors --local-dir <models>\checkpoints` | `models\checkpoints` |
| FramePack weights | Longer videos | The FramePack workflows download them automatically on first run | — |
| ControlNet pose file | *"make this photo follow a pose"* | Ask the AI — it will find one for you | `models\controlnet` |

`hf` is the Hugging Face command-line tool (free, no account needed for these
files). In chat, just ask the AI to get a model for you.

### Images looking low quality?

Just say so in the chat ("these look blurry" / "the AI art looks cheap"). The AI will
score the workflow, then either fix it or build a sharper one — better sampler, more
steps, and a two-pass *refinement* that draws at 512 px and then re-draws at 768 px.
Quality modes: **draft** (fastest), **balanced** (default, ~25 s), **max** (~40 s).

### How long things take

| What | Roughly |
|---|---|
| Image | 10–30 seconds |
| Song edit (cut, loop, EQ, speed) | a few seconds |
| Split a song into stems | about 5 seconds |
| Short video (fast model) | a few seconds |
| Better video (FramePack) | **15–20 minutes** — the AI will warn you first |

## If something goes wrong

- **Installer says Node.js still missing** — close the installer window and run
  `INSTALL.bat` again (after installing, the PATH only refreshes in a new window).
- **Chat says the AI is offline** — run `opencode auth login` once, then restart
  with `START_STUDIO.bat`.
- **Black window says ComfyUI failed** — it usually means another program is
  using the graphics card. Close games/video players and try again.
- **"The AI wants your permission"** — the AI is about to run a command that
  isn't part of the studio. **Allow once** is usually fine; **Reject** if you
  weren't expecting it.
- **The AI says a tool isn't available** — it should use `node studio/studio.js`,
  which is pre-approved. See `AGENTS.md` for the command list.
- **PowerShell blocks `opencode.ps1`** — Windows' default script policy; the
  studio works around it itself, and `INSTALL.bat`/`START_STUDIO.bat` are not
  affected.
- **Restarting:** close the black window and double-click `START_STUDIO.bat` again.
- **The studio won't start / acts strangely** — its own log is at
  `studio\data\server.log` (rewritten on every start). If you need to report a
  problem, that file is the first thing to look at.

## Advanced configuration

The studio reads these environment variables (each is optional — sensible
defaults and auto-detection are built in via `studio/config.js`):

| Variable | Default | Meaning |
|---|---|---|
| `COMFY_ROOT` | auto-detect (`D:\`/`C:\ComfyUI_windows_portable`, …) | Where ComfyUI lives |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI address |
| `COMFY_INPUT` / `COMFY_OUTPUT` / `COMFY_MODELS` | `<root>\ComfyUI\…` | Input/output/models folders |
| `COMFY_PY` | `<root>\python_embeded\python.exe` | Python used for apps |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama address |
| `STUDIO_PORT` | `7860` | Studio web port |
| `OPENCODE_PORT` | `4097` | opencode port |
| `OPENCODE_EXE` | `opencode` | Alternate opencode executable |

## Files added for the studio

| File | What it is |
|---|---|
| `INSTALL.bat` / `INSTALL.ps1` | Double-click installer (checks + installs what's missing) |
| `START_STUDIO.bat` | Double-click to launch everything |
| `studio/config.js` | Machine configuration: paths, ports, auto-detection |
| `studio/server.js` | Local web server + live bridge to ComfyUI and the AI |
| `studio/start.js` | Launcher logic (used by the .bat) |
| `studio/studio.js` | One CLI the AI uses to drive ComfyUI |
| `studio/comfy_tools.js` | The operations behind that CLI |
| `studio/projects.js` | One folder per project: assets, workflows, results |
| `studio/convert.js` | Turns these visual workflows into API payloads |
| `studio/workflow_quality.js` | Scores workflows for output quality (`wf_audit`), fixes them (`wf_improve`), builds tuned ones from scratch (`wf_build`) |
| `studio/plugins/graph.js` | DSP graph engine (same code runs offline and in the browser) |
| `studio/plugins/build.js` | Compiles a plugin definition into a browser AudioWorklet |
| `studio/plugins/test_render.js` | Proves a plugin works before it is built |
| `plugins/` | Audio effect definitions (JSON + signal-chain code) |
| `studio/public/plugin.html` | The plugin host page (sliders + play + export) |
| `studio/apps.js` | App registry — tools/agents the AI builds on request |
| `studio/capabilities.js` | The pool: ComfyUI, Ollama, Hermes, Hugging Face, GitHub, ffmpeg, Python, web bridge |
| `studio/browser.js` | Real-browser bridge: open/read/click/type sites, record their API calls |
| `studio/connectors.js` | Saved API recipes — reverse-engineered sites called as tools |
| `connectors/` | The saved recipes (each a small JSON file) |
| `apps/` | Apps the AI has built (each with its own run.js and manifest) |
| `studio/mcp-comfyui.js` | MCP front door for the same operations |
| `studio/public/` | The browser interface |
| `projects/` | Your project folders (created as you make them) |
| `archive/` | Superseded learning-day workflows (not shown in the picker; move back to root to restore) |
| `opencode.json` | AI configuration (model, MCP, permissions) |
| `AGENTS.md` | Instructions given to the AI |

---

## Workflow catalogue

Organised collection of workflow shortcut JSON files, reviewed against a live
ComfyUI installation.

## Files in this folder
| Filename | Type/Family | Nodes | Links | Key features |
|---------|-------------|-------|-------|--------------|
| AUDIO_Acapella.json | Audio, stems | 3 | 2 | Isolated vocals |
| AUDIO_Cut_Section.json | Audio, edit | 3 | 2 | Trim MM:SS to MM:SS |
| AUDIO_Equalize_Master.json | Audio, master | 4 | 3 | 3-band EQ + loudness |
| AUDIO_Karaoke.json | Audio, stems | 5 | 6 | Instrumental (no vocals) |
| AUDIO_Loop_Section.json | Audio, edit | 6 | 8 | Repeat a section 4x |
| AUDIO_Speed_Shift.json | Audio, edit | 3 | 2 | Speed up / slow down |
| AUDIO_Stems_Split.json | Audio, stems | 6 | 5 | Vocals, drums, bass, other |
| AUDIO_Vocal_Boost.json | Audio, remix | 7 | 9 | Vocals lifted over the mix |
| FramePack_HV_Example.json | FramePack, HV | 31 | 32 | FramePack, HV |
| FramePack_I2V.json | FramePack, I2V | 14 | 18 | FramePack, I2V |
| SD15_ControlNet_Pose_dwpose.json | ControlNet, DWPose | 11 | 14 | Extracts the pose from any photo |
| SD15_ControlNet_Pose_dwpose_improved.json | ControlNet, DWPose, refined | 11 | 14 | Tuned copy: DPM++ 2M Karras + hires refinement pass |
| SD15_ControlNet_Pose_refphoto.json | ControlNet, Pose | 12 | 17 | ControlNet, Pose |
| SD15_ControlNet_Pose_refphoto_improved.json | ControlNet, Pose, refined | 12 | 17 | Tuned copy: DPM++ 2M Karras + hires refinement pass |
| SD15_Image2Img.json | Generic | 8 | 12 | Generic |
| SD15_Image2Img_Balanced.json | Generic, refined | 10 | 16 | Photo restyle: 24 steps, CFG 6.5, 512→768 refinement pass |
| SD15_Image2Img_improved.json | Generic, refined | 10 | 15 | Tuned copy: DPM++ 2M Karras + hires refinement pass |
| SD15_Image2Img_LoRA.json | LoRA | 9 | 14 | LoRA |
| SD15_Image2Img_LoRA_improved.json | LoRA, refined | 9 | 14 | Tuned copy: DPM++ 2M Karras + hires refinement pass |
| SD15_Text2Img.json | T2I | 7 | 9 | T2I |
| SD15_Text2Img_Balanced.json | T2I, refined | 9 | 14 | Tuned copy: 24 steps, CFG 6.5, 512→768 refinement pass |
| SD15_Text2Img_Draft.json | T2I, fast | 7 | 9 | Fastest: 8 steps, no refinement pass |
| SD15_Text2Img_Max.json | T2I, best | 9 | 14 | Best quality: 32 steps, CFG 7, 512→768 refinement pass |
| img2img_controlnet.json | ControlNet | 10 | 15 | ControlNet |
| img2img_controlnet_improved.json | ControlNet, refined | 10 | 15 | Tuned copy: DPM++ 2M Karras + hires refinement pass |
| ltxv_i2v_2b_distilled.json | LTX-Video, I2V | 15 | 19 | LTX-Video, I2V |

## Detailed descriptions

### FramePack_HV_Example.json

- Family: FramePack
- Task: I2V
- Features: HV
- Nodes/Links: 31/32
- Key nodes: LoadFramePackModel, DownloadAndLoadFramePackModel, FramePackSampler, FramePackFindNearestBucket, VAEDecodeTiled, VHS_VideoCombine, LoadImage, CLIPTextEncode, CLIPVisionLoader, DualCLIPLoader

### FramePack_I2V.json

- Family: FramePack
- Task: I2V
- Features: Standard
- Nodes/Links: 14/18
- Key nodes: LoadFramePackModel, FramePackSampler, FramePackFindNearestBucket, VAEDecodeTiled, VHS_VideoCombine, LoadImage, CLIPTextEncode, CLIPVisionLoader, DualCLIPLoader

### SD15_ControlNet_Pose_dwpose.json

- Family: ControlNet
- Task: N/A
- Features: Standard
- Nodes/Links: 11/14
- Key nodes: CheckpointLoaderSimple, KSampler, VAEDecode, SaveImage, ControlNetLoader, DWPreprocessor, ControlNetApplyAdvanced, LoadImage, CLIPTextEncode

### SD15_ControlNet_Pose_refphoto.json

- Family: ControlNet
- Task: N/A
- Features: Standard
- Nodes/Links: 12/17
- Key nodes: CheckpointLoaderSimple, KSampler, VAEDecode, SaveImage, ControlNetLoader, ControlNetApplyAdvanced, LoadImage, CLIPTextEncode

### SD15_Image2Img.json

- Family: SD/Generic
- Task: N/A
- Features: Standard
- Nodes/Links: 8/12
- Key nodes: CheckpointLoaderSimple, KSampler, VAEDecode, SaveImage, LoadImage, CLIPTextEncode

### SD15_Image2Img_LoRA.json

- Family: SD/Generic
- Task: N/A
- Features: LoRA
- Nodes/Links: 9/14
- Key nodes: CheckpointLoaderSimple, KSampler, VAEDecode, SaveImage, LoadImage, CLIPTextEncode

### SD15_Text2Img.json

- Family: SD/Generic
- Task: T2I
- Features: Standard
- Nodes/Links: 7/9
- Key nodes: CheckpointLoaderSimple, KSampler, VAEDecode, SaveImage, CLIPTextEncode

### img2img_controlnet.json

- Family: ControlNet
- Task: Img2Img, ControlNet
- Features: ControlNet
- Nodes/Links: 10/15
- Key nodes: CheckpointLoaderSimple, KSampler, VAEDecode, SaveImage, ControlNetLoader, ControlNetApplyAdvanced, LoadImage, CLIPTextEncode

### ltxv_i2v_2b_distilled.json

- Family: LTX-Video
- Task: I2V
- Features: Standard
- Nodes/Links: 15/19
- Key nodes: LTXVImgToVideo, LTXVConditioning, CheckpointLoaderSimple, KSamplerSelect, VAEDecode, SaveVideo, LoadImage, CLIPTextEncode

---

**Note:** Superseded learning-day workflows live in `archive/` — the manual-pose
`SD15_ControlNet_Pose`, the `framepack_i2v_workflow` duplicate, and the slow
`ltxv_i2v_2b_dev` template. Nothing is deleted; move a file back to the root folder to
restore it.
