# ComfyUI Workflow Shortcuts

## How to use this folder

**Double-click `START_STUDIO.bat`.** That's it.

It starts the image generator (ComfyUI), starts the studio, and opens a browser
window at `http://127.0.0.1:7860`. Keep the black window open while you work.

### What you'll see

- **Chat** (left) — type what you want in plain English, e.g.
  *"make an image of a cozy cabin in a snowy forest"*, or
  *"turn my photo into a video of me dancing"*. The AI's thinking appears live.
- **Workflow** (middle) — the pipeline animates as it runs; each box lights up as
  that step executes.
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
site's own API**: watch the calls a site makes when you press a button, save that as a
recipe (a "connector"), and call it directly next time — no browser, no clicking.
It also wraps local analysis tools: **Mix Doctor** checks a song's BPM, key, loudness
and mix problems by wrapping the Suno Bridge analyzer from your Desktop.

**Safety:** the browser is your real session. The AI will not submit purchases, delete
things, or post publicly unless you explicitly ask for that exact action.

### How long things take

| What | Roughly |
|---|---|
| Image | 10–30 seconds |
| Song edit (cut, loop, EQ, speed) | a few seconds |
| Split a song into stems | about 5 seconds |
| Short video (fast model) | a few seconds |
| Better video (FramePack) | **15–20 minutes** — the AI will warn you first |

### If something goes wrong

- **Black window says ComfyUI failed** — it usually means another program is
  using the graphics card. Close games/video players and try again.
- **"The AI wants your permission"** — the AI is about to run a command that
  isn't part of the studio. **Allow once** is usually fine; **Reject** if you
  weren't expecting it.
- **The AI says a tool isn't available** — it should use `node studio/studio.js`,
  which is pre-approved. See `AGENTS.md` for the command list.
- **Restarting:** close the black window and double-click `START_STUDIO.bat` again.

### Files added for the studio

| File | What it is |
|---|---|
| `START_STUDIO.bat` | Double-click to launch everything |
| `studio/server.js` | Local web server + live bridge to ComfyUI and the AI |
| `studio/start.js` | Launcher logic (used by the .bat) |
| `studio/studio.js` | One CLI the AI uses to drive ComfyUI |
| `studio/comfy_tools.js` | The operations behind that CLI |
| `studio/projects.js` | One folder per project: assets, workflows, results |
| `studio/convert.js` | Turns these visual workflows into API payloads |
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
| `opencode.json` | AI configuration (model, MCP, permissions) |
| `AGENTS.md` | Instructions given to the AI |

---

## Workflow catalogue

Organised collection of workflow shortcut JSON files from Desktop, reviewed against ComfyUI installation on D:\ComfyUI_windows_portable.

## ComfyUI context (reviewed)
- D:\ComfyUI_windows_portable\ComfyUI (install present)
- User workflows present at: user/workflows/ and user/default/workflows/ (some files here also appear on Desktop)

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
| SD15_ControlNet_Pose.json | ControlNet | 10 | 15 | ControlNet |
| SD15_ControlNet_Pose_dwpose.json | ControlNet, DWPose | 11 | 14 | ControlNet, DWPose |
| SD15_ControlNet_Pose_refphoto.json | ControlNet, Pose | 12 | 17 | ControlNet, Pose |
| SD15_Image2Img.json | Generic | 8 | 12 | Generic |
| SD15_Image2Img_LoRA.json | LoRA | 9 | 14 | LoRA |
| SD15_Text2Img.json | T2I | 7 | 9 | T2I |
| framepack_i2v_workflow.json | FramePack, I2V | 14 | 18 | FramePack, I2V |
| img2img_controlnet.json | ControlNet | 10 | 15 | ControlNet |
| ltxv_i2v_2b_dev.json | LTX-Video, I2V | 15 | 19 | LTX-Video, I2V |
| ltxv_i2v_2b_distilled.json | LTX-Video, I2V | 15 | 19 | LTX-Video, I2V |

## Detailed descriptions

(Added after initial review; per-file node summaries in progress)


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

### SD15_ControlNet_Pose.json

- Family: ControlNet
- Task: N/A
- Features: Standard
- Nodes/Links: 10/15
- Key nodes: CheckpointLoaderSimple, KSampler, VAEDecode, SaveImage, ControlNetLoader, ControlNetApplyAdvanced, LoadImage, CLIPTextEncode

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

### framepack_i2v_workflow.json

- Family: FramePack
- Task: I2V
- Features: Standard
- Nodes/Links: 14/18
- Key nodes: LoadFramePackModel, FramePackSampler, FramePackFindNearestBucket, VAEDecodeTiled, VHS_VideoCombine, LoadImage, CLIPTextEncode, CLIPVisionLoader, DualCLIPLoader

### img2img_controlnet.json

- Family: ControlNet
- Task: Img2Img, ControlNet
- Features: ControlNet
- Nodes/Links: 10/15
- Key nodes: CheckpointLoaderSimple, KSampler, VAEDecode, SaveImage, ControlNetLoader, ControlNetApplyAdvanced, LoadImage, CLIPTextEncode

### ltxv_i2v_2b_dev.json

- Family: LTX-Video
- Task: I2V
- Features: Standard
- Nodes/Links: 15/19
- Key nodes: LTXVImgToVideo, LTXVConditioning, CheckpointLoaderSimple, KSamplerSelect, VAEDecode, SaveVideo, LoadImage, CLIPTextEncode

### ltxv_i2v_2b_distilled.json

- Family: LTX-Video
- Task: I2V
- Features: Standard
- Nodes/Links: 15/19
- Key nodes: LTXVImgToVideo, LTXVConditioning, CheckpointLoaderSimple, KSamplerSelect, VAEDecode, SaveVideo, LoadImage, CLIPTextEncode


---


**Note:** FramePack_I2V.json and framepack_i2v_workflow.json are near-duplicates; they differ in CLIPTextEncode prompt text (framepack_i2v_workflow.json includes dancing woman).
