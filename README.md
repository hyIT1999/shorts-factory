# Shorts Factory

A **private, single-user** tool for producing short-form vertical videos from a single topic.
It is a personal production tool, not a SaaS product: there are no accounts, tenants, billing or
authentication.

> **Status: STEP 3 — real AI for RESEARCH, SCRIPT and SCENES.** The worker calls OpenAI (Responses
> API, structured outputs, validated with Zod) for the first three stages, driven by the Channel DNA
> settings. ASSETS (placeholder images), VOICE (Gemini TTS), SUBTITLES (deterministic caption
> segments) and RENDER (FFmpeg → MP4 with burned-in subtitles) are implemented.

## Architecture

```
Angular (frontend/)
   │  HTTP  (/api/*)
   ▼
Node.js API (server/)
   │
   ▼
SQLite + Prisma (prisma/, lib/db/)
   │
   ▼
Background worker (workers/)            polls the SQLite Job table
   │
   ▼
AI / TTS / FFmpeg / Stock media (lib/)  ← placeholder images or Pexels photos
```

The Angular app only talks to the API over HTTP. It never accesses SQLite, Prisma, the
filesystem, FFmpeg, API keys or provider credentials. All of that stays on the server and
worker side.

## Technology stack

| Layer      | Tech                                                            |
| ---------- | --------------------------------------------------------------- |
| Frontend   | Angular 22 (standalone components, router, strict TypeScript)   |
| API        | Node.js 20.19+ / 24, Express 5, TypeScript (ESM)                |
| Database   | SQLite via Prisma 7 (`prisma-client` generator + better-sqlite3 adapter) |
| Validation | Zod 4                                                           |
| Tooling    | tsx (dev runner), tsc, ESLint 10 + typescript-eslint, angular-eslint |

## Folder structure

```
shorts-factory/
├── frontend/              Angular application (own package.json)
├── server/                Node.js API
│   ├── index.ts           entry point (listens on PORT)
│   ├── app.ts             Express app + route mounting
│   ├── config/env.ts      Zod-validated environment
│   ├── http/errors.ts     ApiError + consistent JSON error handler
│   ├── routes/            health, projects, jobs
│   └── services/          project/job database logic
├── workers/
│   ├── worker.ts          polling loop: claim → process → repeat
│   └── research.ts, script.ts, scenes.ts, assets.ts, voice.ts, subtitles.ts, render.ts
│                          pipeline stage handlers (deterministic placeholders)
├── lib/
│   ├── ai/                client.ts (AIClient + provider interface), providers/ (openai, mock),
│   │                      prompts/ (research, script, scenes), schemas/ (Zod contracts)
│   ├── settings/          channel-dna.ts (Channel DNA stored in the Setting table)
│   ├── db/prisma.ts       shared Prisma client (+ WAL setup)
│   ├── assets/            scene visuals (providers, local storage)
│   ├── voice/             narration TTS (providers, WAV, cache)
│   ├── subtitles/         deterministic caption segments (tokenize, segment, wrap, timing)
│   ├── ffmpeg/            safe process runner (spawn, no shell) + ffprobe parsing
│   ├── render/            RENDER: inputs, ASS subtitles, FFmpeg command, output checks
│   ├── jobs/              job engine: create / claim / complete / fail / process
│   └── generated/prisma/  generated Prisma client (git-ignored)
├── tests/                 backend tests (node:test)
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── prisma.config.ts       Prisma 7 CLI configuration
├── data/                  local working data (contents git-ignored)
│   ├── projects/  assets/  audio/  renders/  exports/
│   └── shorts-factory.db  SQLite database (created by migration)
├── templates/documentary/ future video templates
├── .env.example
└── README.md
```

## Installation

Requirements: Node.js 20.19+ (tested on 24.x) and npm 11.

```bash
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
npm install                 # installs root deps, generates the Prisma client,
                            # and installs frontend/ deps (postinstall)
npm run prisma:migrate      # creates data/shorts-factory.db and applies migrations
```

npm 11 only runs dependency install scripts listed under `allowScripts` in `package.json`.
The native/binary packages (better-sqlite3, Prisma engines, esbuild, and so on) are already approved there.

## Development commands

Run all commands from the project root.

| Command                  | What it does                                        |
| ------------------------ | --------------------------------------------------- |
| `npm run dev`            | API server with reload (http://localhost:3000)      |
| `npm run dev:frontend`   | Angular dev server (http://localhost:4200), proxies `/api` to :3000 |
| `npm run build`          | Builds the server (`dist/`) and the frontend (`frontend/dist/`) |
| `npm run build:server`   | Builds the server only                              |
| `npm run build:frontend` | Builds the frontend only                            |
| `npm start`              | Runs the built server (`node dist/server/index.js`) |
| `npm run lint`           | ESLint for server/lib/workers + `ng lint` for frontend |
| `npm run typecheck`      | Type-checks server/lib/workers                      |
| `npm run worker`         | Runs the background worker (polls SQLite for jobs)  |
| `npm run start:worker`   | Runs the built worker (`node dist/workers/worker.js`) |
| `npm test`               | Backend tests (`node:test` + tsx, throwaway SQLite DB per test file; the real-FFmpeg test runs when ffmpeg is found) |
| `npm run trial:render`   | Renders N mock videos with the real FFmpeg on a throwaway DB and prints timings (`-- --count 5`) |
| `npm run data:check`     | Database ↔ files consistency report                 |
| `npm run data:sweep`     | Storage sweep, dry run (`data:sweep:apply` removes)  |

Use three terminals during development:

```bash
npm run dev            # terminal 1 — API on :3000
npm run dev:frontend   # terminal 2 — Angular on :4200
npm run worker         # terminal 3 — job worker
```

### API

| Method & path                     | Description                                             |
| --------------------------------- | ------------------------------------------------------- |
| `GET /api/health`                 | `status: "ok" \| "degraded"` plus queue, worker and disk details (always 200, no token needed) |
| `POST /api/projects`              | Create a project `{ title, topic }` → 201, status DRAFT |
| `GET /api/projects`               | List projects, newest first                             |
| `GET /api/projects/:id`           | Project with videos (+ scenes) and jobs, 404 if missing |
| `DELETE /api/projects/:id`        | Delete project, its records (DB cascade) and its files; 409 `PROJECT_ACTIVE` while a pipeline runs |
| `POST /api/projects/:id/generate` | Start a pipeline → 202; 409 if one is already active    |
| `GET /api/jobs/:id`               | Job status (no payload/result)                          |
| `POST /api/jobs/:id/abort`        | Cancel a `PENDING`/`RUNNING` job; its video and project become `FAILED` (re-run or generate again) |
| `POST /api/videos/:id/rerun`      | Re-run `ASSETS`, `VOICE`, `SUBTITLES` or `RENDER` for the latest video → 202 |
| `GET /api/videos/:id/output`      | The rendered MP4 (Range requests for seeking; `?download=1` to save it) |
| `GET /api/settings/channel-dna`   | Channel DNA (defaults when nothing is saved)            |
| `PUT /api/settings/channel-dna`   | Replace the Channel DNA (all 11 fields, validated)      |

Errors always use `{ "error": { "code": "...", "message": "..." } }` with 400 / 401 / 404 / 409 / 429 / 500.

The API binds to `HOST` (default `127.0.0.1`). With `API_TOKEN` set, every `/api` request except
`/api/health` needs `Authorization: Bearer <token>` or `X-API-Key: <token>` (401 `UNAUTHORIZED`
otherwise; the output route also accepts `?token=` so `<video>` can load it). Mutating requests are
limited to `RATE_LIMIT_PER_MINUTE` per client (429 `RATE_LIMITED` with `Retry-After`).

### Job engine

- `generate` creates a new Video version and a single `RESEARCH` job (PENDING).
- The worker claims the oldest PENDING job with a conditional update
  (`UPDATE … WHERE id = ? AND status = 'PENDING'`), so several workers never process the same job.
- Each successful job stores `resultJson` and creates the next job in the same transaction:
  `RESEARCH → SCRIPT → SCENES → ASSETS → VOICE → SUBTITLES → RENDER` (RENDER also writes
  `Video.outputPath` there, so the job and the video never disagree).
- After `RENDER` the video and project become `COMPLETED`. Any failure marks the job, video and
  project `FAILED` and stops the pipeline.
- A video never has two active jobs: `createJob` checks it in the same transaction and the API
  answers 409 `JOB_ALREADY_ACTIVE` (the project status is the first line of defence).
- Liveness: a claimed job records its worker (`Job.workerId`) and a heartbeat (`Job.heartbeatAt`,
  refreshed every `JOB_HEARTBEAT_MS`). At start-up and every `JOB_RECOVERY_INTERVAL_MS` a worker
  recovers jobs whose heartbeat is older than `JOB_STALE_MS` (their worker died): back to `PENDING`
  while `attempts < JOB_MAX_ATTEMPTS`, otherwise `FAILED` together with the video and project. A
  pipeline therefore never stays `PROCESSING` forever after a crash or reboot.
- Stopping a worker (SIGINT/SIGTERM/SIGHUP, Ctrl+Break on Windows, or the IPC message `shutdown`)
  kills its ffmpeg, puts the job in progress back to `PENDING` and exits; `WORKER_STOP_TIMEOUT_MS`
  bounds the wait. `POST /api/jobs/:id/abort` cancels a job from the outside: a running worker
  notices at its next heartbeat, stops its external processes and discards the result.
- SQLite runs in WAL mode with a 5 s busy timeout so the API and worker(s) can write concurrently.
- `WORKER_POLL_INTERVAL_MS` (default 1000) sets the idle polling interval.

### AI pipeline

```
worker handler → AIClient (Zod validation) → AIProvider → GeminiProvider → Gemini generateContent (REST)
                                                        → OpenAIProvider → OpenAI Responses API
                                                        → MockAIProvider (AI_PROVIDER=mock, tests)
```

- Choose the provider with `AI_PROVIDER` in `.env` (server/worker only, never sent to Angular):
  - `AI_PROVIDER=gemini` + `GEMINI_API_KEY` + `GEMINI_MODEL`
  - `AI_PROVIDER=openai` (default when unset) + `OPENAI_API_KEY` + `OPENAI_MODEL`
  - `AI_PROVIDER=mock`: fixed fixtures, no API calls

  The model must support structured (JSON Schema) output.
- RESEARCH receives only the topic; SCRIPT receives research + Channel DNA; SCENES receives the
  script + Channel DNA. Prompts live in `lib/ai/prompts/`, output contracts in `lib/ai/schemas/`.
- Every AI call uses a strict JSON Schema generated from the Zod schema, and the response is
  validated again with Zod. Invalid output and refusals fail the job at once; rate limits (429),
  5xx, timeouts and network errors are retried with backoff first (`PROVIDER_RETRY_ATTEMPTS`,
  default 4 attempts: 5 s, 15 s, 45 s, a `Retry-After` hint wins) and only then fail the job.
- AI-proposed scene timings are normalized deterministically: 2–8 s per scene, contiguous from 0,
  scaled toward the target duration of the script.
- Research has no web access yet: sources may be empty and are never invented.

### Assets (scene visuals)

- `ASSET_PROVIDER=placeholder` (default) generates a deterministic 1080×1920 PNG per scene
  (offline, free). `ASSET_PROVIDER=mock` returns fixed candidates for tests/development.
  `ASSET_PROVIDER=pexels` searches Pexels photos (`PEXELS_API_KEY`, https://www.pexels.com/api/):
  one portrait search per scene built from the scene's `visualPrompt` keywords, candidates ranked by
  orientation and resolution, photos only (RENDER composes still images). Downloads are https-only
  from `images.pexels.com`, size-capped and never follow redirects; the CDN is asked for the render
  size. Rate limits (free plan: 200 requests/hour, 20 000/month), 5xx and network errors are retried
  with the same backoff as AI/TTS (`PROVIDER_RETRY_*`); `ASSET_SEARCH_LIMIT` (default 15) is the page
  size per search. Attribution (photographer, page URL, Pexels License) is stored in the asset
  metadata and shown per scene on the project page, as the Pexels API terms ask.
- Every downloaded image is checked from its header before it is kept: it must really be a PNG,
  JPEG or WebP of the declared type, at most 12 000 px per side and 40 megapixels
  (`lib/assets/image-info.ts`). Images larger than 1080×1920, or heavier than 2 MB, are re-encoded
  by ffmpeg (`FFMPEG_PATH`, `ASSET_NORMALIZE_TIMEOUT_MS` default 60 s) into a 1080×1920 JPEG with the
  same cover-and-crop as RENDER, so stored images are a few hundred KB and RENDER decodes 2 Mpx per
  scene whatever the provider sent. Placeholders and photos already at the render size are stored as
  they are (the offline providers never need ffmpeg). RENDER repeats the header check
  (`RENDER_INVALID_IMAGE`), so a hand-placed file cannot make ffmpeg allocate gigabytes.
- Files are stored under `data/assets/<projectId>/<videoId>/scene-NN.<ext>` (`DATA_DIR` changes the
  root). The database stores only paths relative to `data/`; RENDER will read these local files.
- Lifecycle: provider candidates are saved as `Asset` rows (`DISCOVERED`, linked by `sceneId`), the
  selected one goes `DOWNLOADING → READY` (or `FAILED`) and is set as `Scene.assetId`. A candidate
  that fails the download or the image check is marked `FAILED` with the reason and the next one is
  tried.
- If a scene has no usable candidate (none found, provider error, download error, no valid image) a
  placeholder is used instead, marked in `metadataJson` with `fallback: true` and `fallbackReason`
  (`NO_CANDIDATES`, `PROVIDER_ERROR`, `DOWNLOAD_FAILED`, `INVALID_IMAGE`). `ASSET_FALLBACK=fail` fails
  the job instead, so a batch never renders placeholder visuals silently: fix the cause (for example
  wait for the Pexels hourly window) and re-run ASSETS. Otherwise only unrecoverable errors
  (database, storage, configuration such as an ffmpeg that cannot start) fail the job.
- Re-running ASSETS for a video replaces its previous assets and files (no duplicates).
- Tests: `npm test` (asset tests use temporary directories, never `data/`; Pexels is tested with a
  fake `fetch`, the ffmpeg normalization with the real ffmpeg when one is found).

### Voice (narration)

- `VOICE_PROVIDER=gemini` (default) uses Gemini TTS with `GEMINI_API_KEY`, `GEMINI_TTS_MODEL` and
  `GEMINI_TTS_VOICE` (a prebuilt voice name). `silent` (valid silent WAVs) and `mock` are for
  offline development and tests only and are never used as an automatic fallback.
- One WAV (PCM 16-bit mono) per scene: `data/audio/<projectId>/<videoId>/scene-NN.wav`, stored as an
  `Asset` with `type = "audio"` and linked via `Scene.voiceAssetId`. The text comes from `Scene.text`
  (ordered by `index`), the language from the script (fallback: Channel DNA), the tone from Channel DNA.
- After all scenes are voiced, `Scene.duration/startTime/endTime` and `Video.duration` are rebuilt
  from the real audio lengths (the SCENES timings were only estimates).
- Vietnamese narration without diacritics is rejected (`TEXT_NOT_VIETNAMESE`); VOICE never edits text.
- Any provider error fails the job (no silent fallback); transient ones (429, 5xx, timeouts) are
  retried with the same backoff as the AI providers first. Scenes already voiced stay `READY`
  and are reused on the next run (`POST /api/videos/:id/rerun` with `{"stage": "VOICE"}`): a scene
  is only re-synthesized when its cache key (provider, model, voice, language, speed, tone, text)
  changes or its file is missing/corrupt.
- Requests are sequential; `VOICE_REQUEST_DELAY_MS` adds a pause between them.

### Subtitles

- Deterministic, CPU-only (no AI, no API, no configuration). Input: `Scene.text` (normalized like
  VOICE), the real timings written by VOICE (`Scene.startTime/endTime/duration`, `Video.duration`;
  every scene must have `voiceAssetId`), `Scene.subtitleEmphasisJson` and the script language
  (fallback: Channel DNA; `vi` and `en` only). Vietnamese without diacritics is rejected.
- Each scene is split into short caption segments (target ~2.2 s, at least 0.8 s, at most 2 lines ×
  22 characters) by a dynamic program that prefers breaks at sentence ends, commas and before
  connectors, and keeps numbers with units, brackets/quotes and emphasized phrases together. Words
  are never cut; a word longer than a line (e.g. a URL) gets its own line with a warning.
- Timing without word timestamps: each scene's audio duration is shared out by weight (syllables +
  pauses after punctuation), in integer milliseconds. Segments are contiguous, never cross a scene
  boundary, and the last one ends exactly at `Video.duration`.
- The `SubtitleResult` (`lib/subtitles/types.ts`, version 1) is stored in the SUBTITLES
  `Job.resultJson`: segments with `startMs/endMs`, `text`, `lines[]` and emphasis `spans[]`, plus
  `inputHash` and non-fatal `warnings`. No file and no database row is written; RENDER turns the
  result into a styled subtitle file.

### Render (FFmpeg)

- Requires **FFmpeg + ffprobe** (a "full"/"gpl" build with libx264, aac and libass; set `FFMPEG_PATH` /
  `FFPROBE_PATH` to the `.exe` files or put them on PATH) and the bundled font
  **`templates/documentary/fonts/BeVietnamPro-Bold.ttf`** (Be Vietnam Pro Bold, SIL Open Font License;
  keep its `OFL.txt` next to it). Missing pieces fail the job with `RENDER_FFMPEG_NOT_FOUND`,
  `RENDER_FFPROBE_NOT_FOUND`, `RENDER_FFMPEG_UNSUPPORTED` or `RENDER_FONT_MISSING`.
  `RENDER_PROVIDER=mock` (tests) validates everything but writes no video.
- Inputs (read from the database on every run, no AI/TTS): the scene timings written by VOICE, the
  selected image of each scene (`Scene.assetId`; its header is checked, `RENDER_INVALID_IMAGE` for a
  corrupt or oversized file), each scene's WAV (`Scene.voiceAssetId`, checksum and length checked) and
  the latest SUBTITLES result, whose `inputHash` must still match the scenes
  (`RENDER_SUBTITLES_STALE` otherwise; RENDER never regenerates subtitles).
- One FFmpeg process: each image is scaled/cropped to 1080×1920 (no distortion) and repeated for exactly
  its frame count, computed from absolute scene boundaries (`round(t × 30)`) so rounding never drifts;
  scenes are concatenated, the subtitles are burned in from a temporary ASS file (libass, bundled font,
  explicit 2-line layout from SUBTITLES, emphasis in #FFD400); the WAVs are concatenated unchanged
  (48 kHz stereo). Output: H.264 `veryfast` CRF 20 yuv420p, 30 fps, AAC 192k, MP4 `+faststart`.
- **Ken Burns motion** (`RENDER_MOTION=kenburns`, the default): every scene gets a slow zoom (1.00→1.10 or
  back) or a pan, chosen deterministically from the video id and the scene index (`lib/render/motion.ts`),
  so a re-run gives the same frames and no two consecutive scenes move the same way. The image is
  supersampled (`RENDER_MOTION_SCALE`, default 2) and cropped per frame by ffmpeg's `zoompan`, which emits
  exactly the scene's frame count; pans advance by whole source pixels with a zoom that keeps the crop
  inside the image, so they never jitter or stall. Scenes too long to pan across zoom instead. Cost:
  about 3–4× the render time of still images (a 24 s video: 29 s instead of 9 s on the dev machine);
  `RENDER_MOTION_SCALE=1` is about twice as fast, `RENDER_MOTION=off` restores still images and
  `RENDER_MOTION_PRESET` forces one preset for every scene. The presets used are stored in the RENDER
  result (`motion`, `motionScale`, `motionPresets`).
- FFmpeg runs through `spawn` with an argument array (never a shell) in a per-job working directory
  `data/tmp/render/<p>/<v>/<jobId>/` that is always removed; `RENDER_TIMEOUT_MS` stops it.
- The result is checked with ffprobe (codecs, size, 30 fps, frame count, duration ±100 ms), then renamed
  over `data/renders/<projectId>/<videoId>/video.mp4`; the job engine stores that path in
  `Video.outputPath` in the same transaction that completes the job. A failed render keeps the
  previous video. The RENDER `Job.resultJson` follows `RenderResultSchema` (`lib/render/types.ts`).
- FFmpeg runs at `-loglevel warning`: whatever it prints on a successful render (typically libass
  font fallbacks for characters the bundled font lacks) is logged and kept in `resultJson.warnings`
  together with the font check's own warnings. `RENDER_THREADS` caps the encoder threads (default:
  all cores).
- Testing the render for real: `tests/render-ffmpeg.test.ts` renders the mock pipeline with the
  ffmpeg/ffprobe from `FFMPEG_PATH`/`FFPROBE_PATH` or PATH (skipped when there is none) and extracts
  a frame to check that the subtitles are burned in. `npm run trial:render -- --count 5` renders N
  mock videos with the real FFmpeg on a throwaway database and prints per-stage timings, fps and
  output sizes: run it on the VPS before the first real batch. CI (`.github/workflows/ci.yml`) runs
  the whole suite on Ubuntu with apt's ffmpeg.
- Re-run a stage for the latest video of a project without calling the script/scene AI:
  `POST /api/videos/:videoId/rerun` with `{"stage": "ASSETS" | "VOICE" | "SUBTITLES" | "RENDER"}`;
  the pipeline continues from that stage (VOICE re-uses cached narration and only re-synthesizes
  changed scenes, so a rate-limited VOICE can simply be re-run).

## Operations

- **Health**: `curl -s http://127.0.0.1:3000/api/health` answers 200 with `status: "ok"` or
  `"degraded"` and why (`checks.worker` none, `checks.jobs` stale, `checks.disk` low), plus queue
  depth, the workers seen in the last 90 s and the free space on `DATA_DIR`. Alert on the body.
- **Storage maintenance** (operator scripts, never run by the pipeline):
  `npm run data:check` compares the database with the files (missing or corrupt assets, videos
  without a rendered file, orphan directories, leftover temp files; exit code 1 when there are
  issues). `npm run data:sweep` is a dry run of the sweep and `npm run data:sweep:apply` removes:
  directories of deleted projects/videos, render working directories abandoned by a killed worker,
  and the files of video versions that are not the latest of their project and are older than
  `DATA_RETENTION_DAYS` (their asset rows are removed and `outputPath` cleared). The latest version
  of every project is never touched. On a built install use `node dist/scripts/data-maintenance.js`.
- **Deleting a project** removes its files too (assets, audio, renders, tmp); it is refused with 409
  while a pipeline is active (abort the job first).
- **Deployment on a Linux VPS**: see [docs/deploy-vps.md](docs/deploy-vps.md) (systemd units, nginx
  with Basic Auth, firewall, backup and maintenance cron jobs, upgrade procedure) and the files in
  [deploy/](deploy/).

## Prisma setup

- The schema is in `prisma/schema.prisma`. The CLI config (schema path, migrations path,
  `DATABASE_URL`) is in `prisma.config.ts`, which loads `.env` through `dotenv`.
- The client is generated into `lib/generated/prisma/` (git-ignored). Import it through
  `lib/db/prisma.ts` (`getPrisma()`).

| Command                   | What it does                                |
| ------------------------- | ------------------------------------------- |
| `npm run prisma:generate` | Regenerates the Prisma client               |
| `npm run prisma:migrate`  | `prisma migrate dev`: creates and applies migrations |
| `npm run prisma:deploy`   | `prisma migrate deploy`: applies existing migrations |
| `npm run prisma:studio`   | Opens Prisma Studio                         |

**Models:** `Project`, `Video`, `Scene`, `Asset`, `Job`, `Setting`.
**Enums:** `ProjectStatus`, `VideoStatus`, `JobStatus`, `JobType`.

Relations:
- Project → Videos, Jobs
- Video → Scenes, Jobs
- Scene → candidate Assets (`Asset.sceneId`)
- Scene → one selected Asset (`Scene.assetId`)

There is intentionally no User model.

## Current MVP scope (STEP 3)

- Monorepo-style layout (frontend / server / workers / lib / prisma / data)
- Project API (create / list / detail / delete / generate) and job status API, validated with Zod
- SQLite-backed job engine (`lib/jobs/`) and a polling worker (`workers/worker.ts`)
- Real AI stages RESEARCH, SCRIPT, SCENES (behind an `AIClient` abstraction); ASSETS, VOICE and
  SUBTITLES and RENDER implemented (see above)
- Channel DNA settings (Setting table) with an API and a basic Settings page
- Angular: functional Create, Projects, Project detail (pipeline progress via HTTP polling, plus
  Research / Script / Scenes sections) and Settings pages
- Backend tests in `tests/` (mock AI, no API credits) including a two-worker concurrency test

## Future pipeline

```
Topic → Research → Fact Check → Script → Scene Breakdown → Visual Assets
      → TTS → Subtitles → Music → FFmpeg → Preview → Export → YouTube
```

Each step will run as a `Job` row processed by the background worker (`workers/worker.ts`).
The queue lives in SQLite, not Redis.

The design for the next steps (Ken Burns motion on stills, background music from a local library,
an EXPORT stage with ready-to-publish metadata and a one-click YouTube upload) is in
[docs/pipeline-design.md](docs/pipeline-design.md) (Vietnamese).

## Intentionally NOT implemented yet

- Web research and fact checking (research uses model knowledge only), other AI providers
- Stock **video** clips (Pexels photos are supported), transitions/motion, music, karaoke subtitles
- Automatic retention (the sweep is a script/cron job, not part of the worker)
- YouTube API / OAuth, autopilot, analytics

Out of scope for this product (never planned):

- Authentication, user management, multi-tenancy, billing/Stripe/subscriptions/credits
- Redis, BullMQ, PostgreSQL, MongoDB, Docker, Kubernetes, microservices
