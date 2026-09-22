# Thiết kế pipeline Shorts tự động v2 (không dùng AI sinh video)

Ngày: 2026-09-21. Trạng thái: **thiết kế đã duyệt, chưa triển khai**. Tài liệu này mô tả bước tiến hoá tiếp theo của Shorts Factory sau audit ([production-audit-2026-09-21.md](production-audit-2026-09-21.md)) và Phase B (ảnh stock Pexels): làm video "sống" hơn bằng chuyển động Ken Burns trên ảnh tĩnh, thêm nhạc nền từ thư viện cục bộ, kết thúc pipeline bằng gói xuất bản (MP4 + tiêu đề/mô tả/hashtag) và đăng YouTube bằng một nút. Không dùng AI sinh video ở bất kỳ bước nào; AI chỉ còn ở RESEARCH/SCRIPT/SCENES như hiện nay.

Mọi số đo trong tài liệu (fps, LUFS, số frame) được **đo thật** trên máy dev (Xeon Gold 6133 2,5 GHz, 5 vCPU, 8 GB, Windows Server 2019, FFmpeg 9.0.2) trong lúc thiết kế; chỗ nào là ước lượng cho VPS sẽ ghi rõ "ước".

## 0. Tóm tắt điều hành

| Hạng mục | Hiện tại (v1) | Đề xuất (v2) |
|----------|---------------|--------------|
| Pipeline | RESEARCH → SCRIPT → SCENES → ASSETS → VOICE → SUBTITLES → RENDER | … → SUBTITLES → **MUSIC** → RENDER → **EXPORT**; **PUBLISH** là action job theo yêu cầu |
| Hình ảnh | ảnh đứng yên, lặp N frame | Ken Burns (zoom/pan) deterministic bằng `zoompan`, frame-exact |
| Âm thanh | chỉ lời đọc TTS | lời đọc chuẩn hoá −16 LUFS + nhạc nền −29 LUFS từ thư viện cục bộ, fade in/out, limiter |
| Kết thúc | `renders/<p>/<v>/video.mp4` | thêm `exports/<p>/<v>/<ngày>-<slug>-v<n>.mp4` + `.json` metadata + poster, `Video.title/description` |
| Đăng | thủ công | nút "Tải lên YouTube" (OAuth, resumable upload, idempotent), private rồi mở trong Studio |
| Chi phí AI | không đổi | không đổi (mọi stage mới deterministic, không gọi AI) |
| Thời gian render | ~130 fps với ảnh phẳng | ~28 fps (motion 2×) hoặc ~54 fps (motion 1×); Short 45 s ≈ 50 s máy dev, ước 70–100 s trên VPS 4 vCPU |

Lộ trình: C1 Motion (2–3 ngày) → C2 Music (4–5 ngày) → C3 Export + UI duyệt (3–4 ngày) → C4 Publish (5–7 ngày + thời gian chờ Google). Mỗi phase có test unit + fake ffmpeg + ffmpeg thật (opt-in) và số đo `trial:render`.

## 1. Nguyên tắc thiết kế (kế thừa từ v1)

1. **Không AI video.** Chuyển động, âm thanh, metadata đều sinh bằng thuật toán deterministic và ffmpeg; rerun không tốn credit.
2. **Một tiến trình ffmpeg cho toàn bộ render**, filtergraph chỉ chứa số và tên file cố định (`subtitles.ass`, `fonts`), cwd là work dir riêng của job (`lib/render/service.ts`). Không path, không text người dùng trong filtergraph.
3. **Frame-exact.** Số frame mỗi scene do `sceneFrameCounts` (`lib/render/timeline.ts`) quyết định từ mốc tuyệt đối; `validateProbe` (`lib/render/output.ts`) vẫn kiểm tra `nb_frames` ±1 và duration ±100 ms. Mọi thay đổi ở video/audio phải giữ hai bất biến này.
4. **Job engine tuyến tính**: `PIPELINE` trong `lib/jobs/types.ts` là thứ tự duy nhất, mỗi video chỉ có một job PENDING/RUNNING (`lib/jobs/create-job.ts`), rerun từ một stage chạy tiếp toàn bộ hạ nguồn (`server/services/videos.ts`), heartbeat và thu hồi job kẹt giữ nguyên.
5. **File đi kèm DB.** Mọi file nằm dưới `DATA_DIR`, đường dẫn tương đối POSIX trong DB, `LocalAssetStorage.resolve()` chặn thoát root, `data:check`/`data:sweep` phải hiểu mọi thư mục mới.
6. **Tương thích ngược.** `resultJson` cũ vẫn parse (field mới có default), tính năng mới tắt được bằng env, chỉ dùng option ffmpeg có từ 4.4 (Ubuntu 22.04) tới 9.

## 2. Kiến trúc pipeline v2

```
RESEARCH → SCRIPT → SCENES → ASSETS → VOICE → SUBTITLES → MUSIC → RENDER → EXPORT
                                                                              └─ Video/Project COMPLETED tại đây
PUBLISH  (action job: POST /api/videos/:id/publish → 1 Job type PUBLISH; KHÔNG nằm trong PIPELINE)
```

| Stage | Đọc | Ghi | Deterministic | Rerun (prerequisite) |
|-------|-----|-----|---------------|----------------------|
| MUSIC | WAV lời đọc của từng scene, `Video.duration`, Channel DNA `musicStyle`, `DATA_DIR/music-library/library.json` | Asset `type:'music'`, `resultJson` = `MusicResult` (kế hoạch trộn âm) | có (seed = videoId) | MUSIC ← SUBTITLES |
| RENDER | như v1 + `MusicResult` mới nhất | MP4 + `RenderResult` (thêm `motion`, `audio`) | có | RENDER ← MUSIC |
| EXPORT | `RenderResult`, `Video.scriptJson`, Channel DNA, metadata asset (credit Pexels), `MusicResult` | `exports/<p>/<v>/…` (mp4 hardlink, json, jpg), `Video.title/description`, `ExportResult` | có | EXPORT ← RENDER |
| PUBLISH | `ExportResult` + file export, token OAuth | upload YouTube, `Video.youtubeVideoId/publishedAt`, `PublishResult` | không (mạng) | EXPORT COMPLETED và `youtubeVideoId == null` |

Lý do đặt MUSIC sau SUBTITLES: cả hai chỉ đọc DB và rất rẻ; giữ đúng "Future pipeline" trong README (… → Subtitles → Music → FFmpeg …); rerun SUBTITLES vẫn tự chạy tiếp MUSIC → RENDER → EXPORT. MUSIC luôn đo loudness lời đọc (để RENDER chuẩn hoá giọng ngay cả khi không có nhạc) và tự **no-op** (`track: null`, `reason`) khi thiếu thư viện hoặc `musicStyle` ∈ {none, off, không, tắt}.

### 2.1 Action job (PUBLISH) và thay đổi engine

`nextJobType` hiện tại (`lib/jobs/types.ts`) là `PIPELINE[PIPELINE.indexOf(type) + 1] ?? null`; với type ngoài PIPELINE `indexOf` = −1 nên trả về `PIPELINE[0]` (RESEARCH). Đây là lỗi tiềm ẩn phải sửa **trước** khi có bất kỳ action job nào. Quy tắc action job:

- `nextJobType(type)` trả `null` khi `!isPipelineJob(type)`; thêm `ACTION_JOBS = [JobType.PUBLISH]`, `isPipelineJob()`.
- `completeJob` (`lib/jobs/complete-job.ts`): với action job chỉ cập nhật job và `videoUpdate` (id YouTube), **không** đụng `Video.status`/`Project.status`.
- `failJob`, `recoverAbandonedJobs`, `abortJob` (`server/services/jobs.ts`): action job thất bại chỉ FAILED ở job; video/project giữ COMPLETED (video vẫn hợp lệ).
- `createJob` giữ nguyên "một PENDING/RUNNING mỗi video": rerun trong lúc đang upload → 409 `JOB_ALREADY_ACTIVE`, và ngược lại.
- `process-job.ts`: mỗi job có một `AbortController`; `ctx.signal` được truyền cho handler; `onLost` (mất heartbeat) và `requestStop` của worker gọi `abort()` (bên cạnh `killActiveProcesses()`), để upload đang chạy dừng ngay.
- Frontend: `isActive` của trang project phải tính cả job PENDING/RUNNING (project vẫn COMPLETED khi PUBLISH chạy); nếu không UI ngừng polling và giấu nút Abort.

## 3. Stage MUSIC

### 3.1 Thư viện nhạc

- Vị trí: `DATA_DIR/music-library/` (hằng `MUSIC_LIBRARY_DIR`, mặc định `music-library`, phải nằm trong DATA_DIR để `storage.resolve()` dùng được). **Không** đưa vào `DATA_KINDS` nên `listDataDirs`, `projectDirs`, `data:sweep` bỏ qua (thư viện không thuộc project nào). VOICE `cleanupStaleAudio` (`lib/voice/service.ts`) chỉ xoá Asset `type:'audio'` và file trong `audio/<p>/<v>/` nên không đụng tới nhạc; ASSETS chỉ xoá `VISUAL_ASSET_TYPES`.
- Manifest `library.json` (Zod strict, xem Phụ lục A): `file` (đúng tên file trong thư mục, không có dấu phân cách đường dẫn, đuôi wav/flac/ogg/opus/mp3/m4a), `title`, `artist`, `license`, `licenseUrl`, `attribution` (bắt buộc trừ khi `license` ∈ {CC0-1.0, public-domain}), `tags[]` (chữ thường ASCII, đã gấp dấu), `loopable`. `file` phải duy nhất.
- Thiếu manifest → stage no-op (`reason: 'library-missing'`); manifest sai JSON/schema → job FAILED `MUSIC_LIBRARY_INVALID` (người vận hành tự sửa); file trong manifest không tồn tại → bỏ qua track đó kèm warning.
- Khuyến nghị định dạng: WAV/FLAC/OGG để lặp không có khe (MP3 có padding của encoder → nghe "tick" ở điểm nối khi `-stream_loop`).

### 3.2 Chọn nhạc (`lib/music/select.ts`, thuần)

1. Gấp dấu `musicStyle`: NFD → bỏ U+0300–036F → `đ/Đ → d` → chữ thường → tách theo ký tự không phải chữ/số. Ví dụ "Cinematic" → `[cinematic]`, "nhạc nền nhẹ nhàng" → `[nhac, nen, nhe, nhang]`.
2. Ứng viên = track có ít nhất một `tag` trùng với một từ; nếu rỗng → tất cả track.
3. Sắp xếp ứng viên theo `file`; chỉ số = `parseInt(sha256(videoId).slice(0, 8), 16) % n`.

Cùng video → cùng track ở mọi lần rerun (RENDER và EXPORT ổn định); Generate mới sinh videoId mới → track khác → có sự đa dạng giữa các video mà không cần trạng thái.

### 3.3 Đo loudness

Đo **qua đúng đường chuyển đổi mà RENDER dùng** (aresample 48 kHz + stereo), vì rematrix mono→stereo làm đổi mức:

```
ffmpeg -nostdin -hide_banner -nostats -i scene-01.wav … -i scene-NN.wav \
  -filter_complex "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];…;[a0]…[aN-1]concat=n=N:v=0:a=1,ebur128=peak=true:framelog=quiet" -f null -
ffmpeg -nostdin -hide_banner -nostats -i <track> \
  -filter_complex "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,ebur128=peak=true:framelog=quiet" -f null -
```

Parse stderr bằng `/^\s*I:\s+(-?\d+(?:\.\d+)?|-inf) LUFS/m` và `/^\s*Peak:\s+(-?\d+(?:\.\d+)?|-inf) dBFS/m` (đã kiểm chứng định dạng trên 9.0.2: `I:  -19.5 LUFS`, `Peak: -3.1 dBFS`; im lặng in `I: -70.0 LUFS`, `Peak: -inf dBFS`). I ≤ −60 LUFS coi là "không đo được" (narration silent/mock) → gain 0. Thời lượng track lấy bằng `ffprobe -show_entries format=duration`.

Đo thật lời đọc Gemini TTS đang có trong `data/audio/` (24 kHz mono): **I = −19,5 LUFS, LRA 2,7 LU, peak −3,1 dBFS**.

### 3.4 Gain và kết quả

- `voiceGainDb = clamp(min(VOICE_TARGET − I_voice, −1 − peak_voice), −12, +12)` với `VOICE_TARGET = −16 LUFS` (với giọng đo ở trên: min(3,5; 2,1) = **+2,1 dB**, bị giới hạn bởi peak).
- `musicGainDb = clamp(MUSIC_TARGET − I_track, −40, +10)` với `MUSIC_TARGET = −29 LUFS` (nhạc thấp hơn lời 12–14 LU).
- `loops = max(0, ceil(durationMs / trackDurationMs) − 1)` → giá trị cho `-stream_loop`.
- Asset row: `type:'music'`, `provider:'library'`, `status:READY`, `sceneId:null`, `videoId` set, `localPath:'music-library/<file>'`, `sizeBytes`, `duration`, `metadataJson` = object `track` dưới đây (có `sha256` → `data:check` và RENDER kiểm tra toàn vẹn như narration; xoá file khỏi thư viện → `ASSET_FILE_MISSING`).

```ts
// lib/music/types.ts (đề xuất)
MusicResultSchema = z.strictObject({
  version: z.literal(1), videoId, durationMs,            // durationMs = Video.duration lúc đo; RENDER so sánh để phát hiện stale
  musicStyle: z.string(),
  narration: { integratedLufs: number|null, truePeakDb: number|null, gainDb: number(−12..12) },
  track: {
    assetId, file, localPath ('music-library/<file>'), sha256,
    title, artist, license, licenseUrl|null, attribution, tags[],
    durationMs, integratedLufs, truePeakDb|null, gainDb (−40..10), loops (0..200),
    fadeInMs: 1000, fadeOutMs: 2000, ducking: 'none' | 'sidechain',
  } | null,
  reason: 'ok' | 'library-missing' | 'library-empty' | 'style-none',
  libraryHash: sha256 của library.json | null, ffmpegVersion | null, measuredAt,
})
```

Mã lỗi mới: `MUSIC_LIBRARY_INVALID`, `MUSIC_TRACK_INVALID` (ebur128 exit ≠ 0), `MUSIC_FFMPEG_NOT_FOUND`.

## 4. RENDER v2: Ken Burns và trộn nhạc

### 4.1 Ken Burns bằng `zoompan` (đã kiểm chứng)

Ngữ nghĩa đã đo trên 9.0.2 (cùng option từ FFmpeg 2.4, có trên 4.4/6.1): `zoompan` nhận **một** frame ảnh và phát ra **đúng `d` frame** (90/90, 300/300), pts 0..d−1, timebase 1/`fps`; biến `on` = chỉ số frame ra trong scene, `zoom` = giá trị vừa tính cho frame đó. Ảnh có 2 frame vào sẽ cho 2·d frame, nên chuỗi motion **bỏ `loop`** (v1 dùng `loop=loop=F−1`). Giữ `settb=1/30,setpts=N` sau zoompan để `concat` nhận pts liên tục như v1.

Chuỗi mỗi scene k (S = hệ số supersample, mặc định 2 → 2160×3840; F = số frame của scene):

```
[k:v]scale=<1080S>:<1920S>:force_original_aspect_ratio=increase:flags=lanczos:out_color_matrix=bt709:out_range=tv,
crop=<1080S>:<1920S>,setsar=1,format=yuv444p,
zoompan=z='<Z>':x='<X>':y='<Y>':d=<F>:s=1080x1920:fps=30,
format=yuv420p,settb=1/30,setpts=N[v<k>]
```

`RENDER_MOTION=off` giữ chuỗi v1 byte-for-byte (test hiện có không đổi). Chống rung: `zoompan` cắt cửa sổ theo pixel nguyên của ảnh nguồn (và ép chẵn với yuv420p) nên supersample 2× + `yuv444p` giảm bước lượng tử xuống ≤ 0,5 px đầu ra; pan dùng bước nguyên (dưới) nên không rung.

Bảng preset (S = 2; k = bước pan tính bằng px nguồn/frame: k = 2 khi F < 120, k = 1 khi F ≥ 120, tức 30 hoặc 15 px đầu ra/giây; ở S = 1 dùng k = 1):

| Preset | Z | X | Y |
|--------|---|---|---|
| zoom-in | `1+0.10*on/<F−1>` | `iw/2-(iw/zoom/2)` | `ih/2-(ih/zoom/2)` |
| zoom-out | `1.10-0.10*on/<F−1>` | như trên | như trên |
| pan-right / pan-left | `<zp>` với `zp = ceil3(iw / (iw − k(F−1) − 2))` | `<k>*on` / `<k(F−1)>-<k>*on` | `ih/2-(ih/zoom/2)` |
| pan-down / pan-up | `<zp>` với `zp = ceil3(ih / (ih − k(F−1) − 2))` | `iw/2-(iw/zoom/2)` | `<k>*on` / `<k(F−1)>-<k>*on` |

`ceil3` làm tròn lên 3 chữ số thập phân để `iw − int(iw/zp) ≥ k(F−1) + 2`, nên zoompan không bao giờ clamp toạ độ và chuyển động không bao giờ "khựng". Easing tuyến tính (đọc như trôi chậm, cắt cảnh vốn là hard cut); smoothstep `1+0.10*(3*pow(t,2)-2*pow(t,3))` parse được trên 9.0.2 và có thể thêm sau cho zoom (không dùng cho pan bước nguyên).

Deterministic (`lib/render/motion.ts`, thuần): `h = sha256(videoId)`; `offset = h[0] % 4`; chu kỳ `[zoom-in, pan, zoom-out, pan]` theo `(sceneIndex + offset) % 4`; trục pan = bit 0 của `h[1 + sceneIndex]`, hướng = bit 1. Hai scene liền nhau không lặp motion; rerun tái tạo y hệt. Env: `RENDER_MOTION=kenburns|off`, `RENDER_MOTION_SCALE=1|2|3`, `RENDER_MOTION_PRESET=auto|zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down` (test và sở thích).

Frame-exact: Σ F không đổi, audio không đổi → `sceneFrameCounts`, `validateProbe` giữ nguyên. RAM: ffmpeg ≤ 6.1 đẩy mọi frame ảnh vào graph ngay từ đầu, mỗi chuỗi giữ ảnh đã upscale ≈ 25 MB ở 2× → tối đa +500 MB với 20 scene (VPS 8 GB đủ).

Phương án đã thử và loại: `crop` chỉ tính `w/h` một lần lúc init (checksum frame giống hệt ở n = 0/1/149/299) nên không zoom được; `scale` với `eval=frame` đổi kích thước từng frame làm filter phía sau bị clamp; `perspective=eval=frame` sub-pixel nhưng tính lại LUT mỗi frame: 25 fps (cubic) / 42 fps (linear, mờ).

Hiệu năng đo thật (300 frame, kể cả libx264 veryfast, `-benchmark`, máy dev 5 vCPU):

| Chuỗi | Thời gian | fps |
|-------|-----------|-----|
| v1 (loop, ảnh phẳng) | 2,38 s | 126 |
| zoompan 1× yuv444p | 5,58 s | 54 |
| zoompan 2× yuv420p | 6,19 s | 48 |
| **zoompan 2× yuv444p (khuyến nghị)** | 10,85 s | **28** |
| zoompan 3× yuv444p | 25,2 s | 12 |

zoompan đơn luồng, tự khởi tạo lại swscale mỗi frame (~33 ms/frame ở 2× yuv444p); maxrss 427 MB (chủ yếu x264). Short 45 s (1350 frame) ≈ 49 s máy dev, **ước 70–100 s trên VPS 4 vCPU**; video 180 s ≈ 193 s máy dev / ước 400 s VPS → khuyến nghị `RENDER_TIMEOUT_MS=900000` khi bật motion. Nếu VPS đo dưới 15 fps: `RENDER_MOTION_SCALE=1` (54 fps, pan vẫn không rung nhờ bước nguyên).

### 4.2 Trộn nhạc (đã kiểm chứng độ dài chính xác tới sample)

Input: ảnh 0..N−1, WAV N..2N−1 (như v1), nhạc ở argv **2N** với `-stream_loop <loops>` đặt trước `-i`. Graph audio (mọi giá trị là số; `<D>` = durationMs/1000, 3 chữ số thập phân):

```
[a0]…[aN-1]concat=n=N:v=0:a=1,volume=<voiceGainDb>dB[voice];
[2N:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=<D>,
      volume=<musicGainDb>dB,afade=t=in:st=0:d=1,afade=t=out:st=<D−2>:d=2[music];
[voice][music]amix=inputs=2:duration=first:dropout_transition=0,volume=2,
      alimiter=limit=0.891:attack=5:release=50:level=false[aout]
```

- `volume=2` bù phép chia 1/n của `amix` (chính xác trong float) thay vì option `normalize=0` (không chắc có trên 4.4). `duration=first` kết thúc đúng theo lời đọc: đã đo `amix`, `alimiter`, `sidechaincompress` đều cho **đúng 10,000 s** (1 920 000 byte s16 stereo) với input 10 s. `-stream_loop 2` trên WAV 8,12 s cho đúng 3 lần phát; `atrim=end=5` cho đúng 5,000 s. Đầu ra vẫn là **một** stream AAC 48 kHz stereo trong ±100 ms → `validateProbe` không đổi.
- Không có `MusicResult` (video cũ, hoặc RENDER chạy trước C2): dùng graph v1. Có `MusicResult` nhưng `track: null`: `concat,volume=<voiceGainDb>dB,alimiter=…`. `MusicResult.durationMs ≠ Video.duration` hoặc sha256 track lệch → `RENDER_MUSIC_STALE` ("re-run MUSIC"), cùng cơ chế với `RENDER_SUBTITLES_STALE`.
- **Ducking: mặc định tắt** (`MUSIC_DUCKING=none`, gain cố định). Lời đọc phủ gần kín video, khoảng nghỉ giữa scene chỉ 0,3–0,8 s: compressor sidechain với release < 400 ms sẽ "bơm", release ≥ 600 ms thì không kịp hồi trong khoảng nghỉ → nghe không khác gain cố định −13 LU mà thêm rủi ro khác biệt phiên bản. Tuỳ chọn `sidechain` (ghi để thử sau): `[voice]asplit[v][sc]; [music][sc]sidechaincompress=threshold=0.05:ratio=3:attack=30:release=600:knee=4:detection=rms:link=average[ducked]` với `MUSIC_TARGET=−24` (nhạc nghe rõ trong khoảng nghỉ, hạ 4–6 dB khi có lời).
- Mục tiêu loudness: lời −16 LUFS, nhạc −29 LUFS, limiter −1 dBFS (0,891) → mix tổng ≈ −16 LUFS; YouTube chuẩn −14 LUFS chỉ hạ, không kéo lên, nên không bị méo.
- `alimiter` có lookahead ≤ 5 ms (trong dung sai ±100 ms, không nghe thấy với ảnh tĩnh).

### 4.3 Thay đổi ở RENDER

- `lib/render/command.ts`: chọn chuỗi theo `motion`; input nhạc và graph audio ở trên; `REQUIRED_FILTERS` += `zoompan, volume, atrim, afade, amix, alimiter, ebur128` (+ `asplit, sidechaincompress` khi bật ducking) để preflight `RENDER_FFMPEG_UNSUPPORTED` bắt sớm trên ffmpeg thiếu filter.
- `lib/render/types.ts`: `RenderScene` thêm `motion`; `RenderInput` thêm `music`; `RenderResultSchema` thêm field **có default** (`motion: 'off'|'kenburns'`, `motionScale`, `motionPresets[]`, `audio: { voiceGainDb, music: {assetId, gainDb, loops, ducking} | null }`) → result cũ vẫn parse.
- `lib/render/input.ts`: nạp `MusicResult` mới nhất, kiểm tra file nhạc (tồn tại, sha256, ≤ 50 MB) như narration.
- `lib/render/index.ts`: env `RENDER_MOTION*`, `MUSIC_DUCKING`; test unit assert chuỗi `zoompan=…:d=<F>` và không có `loop=` khi bật, y hệt v1 khi tắt; test ffmpeg thật: ghi đè ảnh scene bằng dải sáng ngang, render với `RENDER_MOTION_PRESET=pan-down`, trích frame đầu/cuối scene → tâm dải sáng dịch ≥ 20 px; render lại với `off` → hai frame giống hệt.

## 5. Stage EXPORT

Deterministic, không AI (`lib/export/metadata.ts` thuần + `lib/export/service.ts`).

- `title` = `script.title` (bỏ `<>`, ≤ 100 ký tự; không thêm "#Shorts": không cần để được xếp Shorts, dễ vượt 100 ký tự).
- `description` ≤ **5000 byte UTF-8** (giới hạn YouTube tính byte): `hook` ⏎⏎ `cta` ⏎⏎ "Nguồn tham khảo:" (≤ 10 dòng `- tiêu đề – url`) ⏎⏎ "Hình ảnh:" (mỗi photographer Pexels một dòng, dedupe) ⏎ "Nhạc nền:" (attribution) ⏎⏎ dòng hashtag. Vượt ngân sách → cắt bớt nguồn rồi credit ảnh; **không bao giờ cắt attribution nhạc/ảnh còn lại** (nghĩa vụ license). Ví dụ ở Phụ lục C.
- `hashtags` ≤ 15 (YouTube bỏ qua tất cả nếu > 15): `#shorts`, `#<niche gấp dấu>`, rồi ≤ 5 từ tiêu đề đã gấp dấu (≥ 4 ký tự, bỏ stop-word tiếng Việt). `tags` (snippet.tags, tổng ≤ 500 ký tự): tiêu đề, niche, các cụm keyword chưa gấp dấu. `language` = `script.language`; `categoryId` từ `YOUTUBE_CATEGORY_ID` (mặc định 27 Education); `privacyStatus` từ `YOUTUBE_DEFAULT_PRIVACY` (mặc định `private`); `madeForKids: false`.
- File: `exports/<p>/<v>/<yyyy-mm-dd>-<slug>-v<version>.mp4` (slug = tiêu đề gấp dấu, `[^a-z0-9]+` → `-`, ≤ 60 ký tự, fallback `video`), sidecar `<base>.json` (metadata + credits, dùng khi upload tay), poster `<base>.jpg` bằng `ffmpeg -nostdin -hide_banner -loglevel error -y -ss 1.000 -i <mp4> -frames:v 1 -update 1 -q:v 2 <jpg>`. Thư mục do stage sở hữu: `removeDir` rồi tạo lại (rerun an toàn). `fs.link` trước (0 byte thêm), `EXDEV/EPERM/ENOTSUP` → copy sang `.tmp` rồi rename. Hardlink giữ inode cũ khi RENDER sau đó `rename` `video.mp4` mới đè lên → export là snapshot bất biến cho tới khi EXPORT chạy lại (pipeline tự làm sau mỗi RENDER).
- `videoUpdateFor(EXPORT)` → `{ title, description }` (`Video.description` có sẵn trong schema, chưa stage nào ghi; `Video.title` hiện chỉ chép tiêu đề project).
- RENDER mock (test) → `ExportResult.provider: 'mock'` (chỉ metadata, không file) để mọi test "chạy tới COMPLETED" hiện có vẫn đúng.
- `ExportResultSchema`: `version, videoId, exportedAt, provider ('file'|'mock'), file {path, fileName, sizeBytes, sha256, link: 'hardlink'|'copy'} | null, poster | null, sidecar | null, source {renderJobId, outputPath, renderedAt, fileSize, durationMs}, metadata {title, description, tags, hashtags, language, categoryId, privacyStatus, madeForKids:false}, credits {photos[], music|null}, warnings[]`.

## 6. PUBLISH (đăng YouTube bằng một nút)

### 6.1 OAuth và lưu token

- Google Cloud: bật YouTube Data API v3, tạo OAuth client loại **Desktop app**; `.env`: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`.
- `npm run youtube:auth` (`scripts/youtube-auth.ts`): loopback flow trên `127.0.0.1:<cổng ngẫu nhiên>`, `access_type=offline&prompt=consent`, scope `https://www.googleapis.com/auth/youtube.upload`; ghi `DATA_DIR/secrets/youtube-oauth.json` (`{refresh_token, scope, obtainedAt}`, mode 0600, đường dẫn đổi bằng `YOUTUBE_TOKEN_FILE`). Trên VPS: chạy CLI ở máy có trình duyệt rồi `scp` file, hoặc SSH tunnel.
- **Khuyến nghị file, không phải bảng Setting**: DB được backup/copy và duyệt trên UI; Channel DNA đã có quy tắc "không lưu credential" (`lib/settings/channel-dna.ts`); file dễ xoay vòng/thu hồi. `secrets/` không phải DATA_KIND; `deploy/backup.sh` thêm `secrets/` và `music-library/` vào danh sách rsync.

### 6.2 Upload và idempotency

- `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` (header `X-Upload-Content-Type: video/mp4`, `X-Upload-Content-Length`) → `Location` = session URI, lưu Setting `youtube.uploadSession.<videoId>` = `{uri, size, sha256, createdAt}` → PUT từng chunk 8 MiB (bội số 256 KiB) với `Content-Range: bytes a-b/size`; 308 → tiếp; 200/201 → JSON có `id`. Body: `snippet {title, description, tags, categoryId, defaultLanguage, defaultAudioLanguage}`, `status {privacyStatus, selfDeclaredMadeForKids: false}`.
- Idempotency: API từ chối 409 `ALREADY_PUBLISHED` khi `Video.youtubeVideoId` đã có; cột `@unique`. Trước khi tạo session mới, handler tìm session đã lưu (< 24 h, cùng sha256) và hỏi trạng thái (`PUT` `Content-Length: 0`, `Content-Range: bytes */size`): 308 → resume từ `Range`, 200/201 → upload đã xong (worker chết giữa lúc thành công và `completeJob`) → ghi id, 404/410 → session mới. Xoá session khi xong hoặc fail hẳn.
- Lỗi: `invalid_grant`/401 → `PUBLISH_AUTH` ("chạy lại npm run youtube:auth"); 403 `quotaExceeded` → `PUBLISH_QUOTA` (không retry; quota reset 00:00 giờ Thái Bình Dương); 400 → `PUBLISH_INVALID_METADATA`; 5xx/mạng → `lib/retry.ts` theo từng chunk. Heartbeat chạy độc lập bằng timer nên upload dài không bị thu hồi; abort → `ctx.signal` huỷ fetch (`AbortSignal.any([signal, AbortSignal.timeout(120_000)])` mỗi chunk), job CANCELLED, session giữ lại cho lần thử sau.
- `PublishResultSchema`: `youtubeVideoId (11 ký tự), url, studioUrl, privacyStatus, uploadStatus, exportPath, exportSha256, bytes, chunks, resumed, attempts, quotaUnits: 1600, metadata`.

### 6.3 Ràng buộc chính sách YouTube (phải ghi trong runbook)

- `videos.insert` tốn ~**1600 unit**, quota mặc định **10 000 unit/ngày → ~6 video/ngày**. Muốn hơn phải nộp form "YouTube API Services quota extension" (kèm compliance audit).
- Project API chưa qua audit (tạo sau 28-07-2020) thì video upload bằng API bị **ép private**. Vì vậy luồng một nút = "tải lên private → mở công khai trong YouTube Studio" (link `https://studio.youtube.com/video/<id>/edit`) cho tới khi audit xong. Đây vẫn tiết kiệm phần lớn thao tác (không phải chọn file, điền tiêu đề/mô tả/hashtag, chờ upload).
- Consent screen phải ở trạng thái **In production** (một người dùng, chưa verify vẫn được, chỉ hiện màn cảnh báo một lần); ở "Testing" refresh token hết hạn sau 7 ngày.

### 6.4 API và UI

- `POST /api/videos/:id/publish` `{ privacyStatus? }` → 202 `{ jobId }` (điều kiện: video mới nhất, project không QUEUED/PROCESSING, EXPORT COMPLETED có file, `youtubeVideoId` null). `GET /api/videos/:id/export[?download=1]` (tái dùng khối `sendFile` của route output). `GET /api/youtube/status` → `{ configured, tokenFile, defaultPrivacy }` (không bao giờ trả secret).
- Project detail thêm `video.export` (metadata, credits, có file/poster hay không) và `video.publish` (`state: none|uploading|published|failed`, id, url, error) suy từ cột + job PUBLISH mới nhất.
- Trang project: card "Xuất bản": tiêu đề/mô tả/hashtag với nút copy, tải file export, poster, chọn privacy, nút "Tải lên YouTube" (khoá khi chưa cấu hình hoặc đang có job), dòng trạng thái (đang tải / đã đăng + link youtu.be và Studio / lỗi + thử lại), Abort áp dụng cho PUBLISH. Settings: trạng thái kết nối YouTube và số track trong thư viện nhạc (chỉ đọc).

## 7. Thay đổi hạ tầng theo file

| Nhóm | File | Thay đổi |
|------|------|----------|
| Prisma | `prisma/schema.prisma` | `JobType` += MUSIC, EXPORT, PUBLISH (**không cần SQL migration**: enum lưu dạng TEXT không CHECK, chỉ `prisma generate`; xác nhận bằng `prisma migrate dev --create-only` cho diff rỗng). `Video.youtubeVideoId String? @unique`, `Video.publishedAt DateTime?` (**migration thật**). Không thêm cột trạng thái publish. `Asset.type` thêm giá trị `'music'` (string tự do). |
| Engine | `lib/jobs/types.ts` | `PIPELINE` 9 stage; `ACTION_JOBS`, `isPipelineJob`; sửa `nextJobType`; `jobPayloadSchema` += `publish: { privacyStatus }` optional; `JobContext` += `music`, `exporter`, `youtube`, `signal?` |
| | `lib/jobs/complete-job.ts` | `CompletedVideoUpdate` = `Partial<Pick<VideoUpdateInput, 'outputPath'|'title'|'description'|'youtubeVideoId'|'publishedAt'>>`; nhánh action job không đổi status |
| | `lib/jobs/fail-job.ts`, `recover-jobs.ts`, `server/services/jobs.ts` | action job chỉ FAILED ở job |
| | `lib/jobs/process-job.ts` | `handlers` += 3 (compile error tới khi đủ); `videoUpdateFor` thành switch (RENDER → outputPath, EXPORT → title/description, PUBLISH → youtubeVideoId/publishedAt); `AbortController` mỗi job; `lib/jobs/active.ts` mới với `abortActiveJobs()` |
| | `workers/worker.ts`, `workers/{music,export,publish}.ts` | dựng service từ env, log cấu hình, `requestStop` gọi `abortActiveJobs()` |
| Domain mới | `lib/music/{index,types,library,select,measure,service}.ts`, `lib/export/{index,types,metadata,service}.ts`, `lib/youtube/{index,types,oauth,upload,service}.ts`, `scripts/youtube-auth.ts` | theo mục 3, 5, 6; factory `create*ServicesFromEnv(storage, env)` như `lib/voice/index.ts` để `render-trial` tiêm env |
| Storage | `lib/assets/storage.ts` | union kind + `DATA_KINDS` += `'exports'`, `exportDir()`; hằng `MUSIC_LIBRARY_DIR = 'music-library'`, `SECRETS_DIR = 'secrets'` (không phải kind) |
| Maintenance | `lib/maintenance/check.ts` (TEMP_FILE kinds += exports), `lib/maintenance/sweep.ts` (retention kinds += exports) | Asset `music` READY được kiểm file/size/sha sẵn; OLD_VERSION_ROWS xoá row music của version cũ, không đụng file thư viện |
| Ops | `deploy/backup.sh` (+ `music-library/`, `secrets/`), `docs/deploy-vps.md` (mục Google Cloud, quota, `RENDER_TIMEOUT_MS`), `.env.example`, `README.md` | |
| API | `server/services/videos.ts` (`RERUN_STAGES` += MUSIC, EXPORT; `PREREQUISITE` MUSIC←SUBTITLES, RENDER←MUSIC, EXPORT←RENDER; `publishVideo`, `getVideoExport`), `server/routes/videos.ts`, `server/services/projects.ts` (export/publish trong detail), route `youtube/status` | |
| Frontend | `frontend/src/app/models/api.ts` (`JobType`, `PIPELINE`, `RERUN_STAGES` — hai bản sao thủ công của backend), `pages/project-detail/*`, `pages/settings/*` | |
| Test | `tests/pipeline.test.ts`, `concurrency.test.ts`, `render-service.test.ts` (đếm job), voice/subtitles pipeline tests, `tests/helpers.ts` (ctx.music/exporter/youtube), test mới cho từng domain | CI: thêm job `ubuntu-22.04` để test ffmpeg thật chạy trên 4.4 (hiện chỉ có 24.04 = 6.1) |

## 8. Hiệu năng, chi phí, dung lượng

| Hạng mục | v1 | v2 | Ghi chú |
|----------|----|----|---------|
| AI/TTS mỗi video | như hiện nay | không đổi | MUSIC/EXPORT/PUBLISH không gọi AI |
| RENDER (Short 45 s, 1350 frame) | ~10 s máy dev | ~49 s máy dev (2× yuv444p) / ~25 s (1×); ước 70–100 s VPS 4 vCPU | + ~1 s đo loudness ở MUSIC |
| RAM render | ~430 MB | + ≤ 25 MB/scene (≤ +500 MB) | |
| Dung lượng | ~0,3–0,6 MB/scene ảnh + WAV + MP4 | + thư viện nhạc (50 track × 3–5 MB ≈ 250 MB, một lần) + export hardlink 0 byte (copy 10–15 MB nếu khác volume) + poster ~100 KB + json | retention `exports` theo `DATA_RETENTION_DAYS` |
| Throughput đăng | thủ công | ≤ 6 video/ngày (quota mặc định) | tăng cần quota extension |
| Loudness | phụ thuộc giọng (−19,5 LUFS đo được) | lời −16 LUFS, nhạc −29 LUFS, peak ≤ −1 dBFS | chỉnh bằng env |

## 9. Lộ trình

| Phase | Phạm vi | Ước | "Xong" khi |
|-------|---------|-----|-----------|
| **C1 Motion** | `lib/render/motion.ts`, chuỗi zoompan trong `command.ts`, env `RENDER_MOTION*`, field result, `REQUIRED_FILTERS`, test unit + fake runner + ffmpeg thật (tâm dải sáng dịch ≥ 20 px với `pan-down`; `off` → frame giống hệt), README/deploy (timeout) | 2–3 ngày | `npm run typecheck && npm run lint && npm test` xanh trên dev và CI; `npm run trial:render -- --count 3` với `RENDER_MOTION=off|kenburns` ghi số trên dev **và VPS** (ngưỡng ≥ 15 fps ở scale 2, không đạt thì tài liệu hoá scale 1) |
| **C2 Music** | `lib/music/*`, `workers/music.ts`, PIPELINE/RERUN/PREREQUISITE + danh sách frontend, trộn nhạc + kiểm tra input + staleness trong RENDER, hằng storage, backup.sh, test (manifest, gấp dấu, chọn seeded, parser ebur128 kể cả `-inf`, fake runner: `-stream_loop`, index 2N, row music sống sót sau rerun VOICE/ASSETS; ffmpeg thật: sine 3 s làm thư viện tạm, lời đọc sine −20 dBFS → output ebur128 I ∈ [−18, −14] LUFS, peak ≤ −0,5 dBFS; render chỉ nhạc → −29 ± 2 LUFS), `library.json` mẫu trong docs | 4–5 ngày | test xanh; `data:check` sạch sau trial; người vận hành nghe 1 Short thật và chốt cân bằng lời/nhạc |
| **C3 Export + UI duyệt** | `lib/export/*`, `workers/export.ts`, DATA_KIND `exports` + check/sweep/backup, `videoUpdateFor`, API `/export` + detail payload, card frontend, test hardlink/copy trên Windows + Linux CI | 3–4 ngày | export + sidecar + poster cho một project thật; metadata hiện đúng trên UI; `data:sweep` dry-run liệt kê export của version cũ |
| **C4 Publish** | engine action job (types/complete/fail/recover/abort/process-job/active.ts), migration `video_publish`, `lib/youtube/*`, `scripts/youtube-auth.ts`, API + status, frontend, tài liệu Google Cloud/quota/audit/private-only | 5–7 ngày + thời gian chờ Google | test fetch giả xanh (token, session, chunk 308→200, resume, 401/403/5xx; `nextJobType(PUBLISH) === null`; complete/fail/abort/recover không đổi status video/project; 409 khi có job khác); 1 upload private thật thành công và `youtubeVideoId` được ghi; bấm lần 2 → 409; kill worker giữa upload → restart resume/ghi id |
| Sau v2 | clip stock (Pexels Videos, cần timeline mới), transition `xfade`, karaoke từng từ (`segment.words` đã dành chỗ), autopilot theo lịch | — | — |

Thứ tự C1 → C2 → C3 → C4 là bắt buộc về mặt phụ thuộc (C2 cần input nhạc trong RENDER của C1 đã ổn định; C3 cần MusicResult cho credit; C4 cần ExportResult). Mỗi phase kết thúc bằng cập nhật README, `.env.example`, `docs/deploy-vps.md` và Phụ lục trong audit.

**Trạng thái:** C1 Motion **đã làm** 2026-09-21 trên máy dev (xem [production-audit-2026-09-21.md](production-audit-2026-09-21.md) Phụ lục F): 25 fps ở scale 2 với video mock 24,3 s, dải sáng dịch 108,5 px với `pan-down`, đúng 729 frame; chưa đo trên VPS. C2–C4 chưa làm.

## 10. Rủi ro và giảm thiểu

| Rủi ro | Giảm thiểu |
|--------|-----------|
| Khác biệt ffmpeg 4.4 / 6.1 / 9 | Chỉ dùng option có từ lâu (không `amix normalize`, không `loudnorm`); preflight `REQUIRED_FILTERS` fail sớm với `RENDER_FFMPEG_UNSUPPORTED`; CI thêm job 22.04 |
| Rung zoompan | supersample 2× + yuv444p + pan bước nguyên; duyệt bằng mắt ở C1; đổi preset/scale bằng env không cần sửa code |
| CPU render ×4 | bị chặn trên bởi quota upload 6/ngày; `RENDER_THREADS`; `RENDER_TIMEOUT_MS=900000`; RAM +25 MB/scene |
| Loudness khác giọng | gain giới hạn theo peak + limiter; test ebur128; target chỉnh bằng env |
| License / Content ID | manifest bắt buộc license + attribution, attribution luôn vào mô tả; ưu tiên CC0 hoặc nhạc tự sở hữu (track CC-BY nằm trong thư viện Content ID vẫn có thể bị claim) |
| YouTube | private-only tới khi audit; 6 upload/ngày; consent screen "In production"; `@unique` + hỏi session để idempotent; secrets 0600 ngoài git (`data/**` đã ignore) |
| Hardlink trên Windows | `EPERM/EXDEV` → copy; file bị player giữ → retry như `promoteOutput` |
| Tăng dung lượng | export là hardlink; retention `exports`; thư viện/secrets nằm ngoài sweep; `data:check` báo track thiếu |
| Engine | sửa `nextJobType` trước mọi action job; frontend `isActive` phải tính job đang chạy |
| Test bị đổi | mọi assertion đếm job/`PIPELINE.length` dời theo; RENDER mock → EXPORT mock |

## 11. Câu hỏi mở cho người vận hành (không chặn triển khai)

1. Nguồn nhạc và license: CC0, CC-BY hay YouTube Audio Library (chỉ dùng trên YouTube)? Chấp nhận attribution tự chèn vào mô tả? Cần ghi đè track/"không nhạc" theo từng project hay `musicStyle` toàn cục là đủ?
2. Chấp nhận render chậm ~×4 (2× yuv444p, ≈ 1–1,5 phút/Short trên VPS) hay ưu tiên 1× (≈ ×2)?
3. Cân bằng lời/nhạc (−16 / −29 LUFS, fade 1 s / 2 s) chốt sau lần nghe đầu; ducking tắt mặc định.
4. YouTube: có làm compliance audit + xin quota, hay chấp nhận "upload private, mở trong Studio, ≤ 6/ngày"? Category mặc định 27 (Education) hay 28 (Science & Technology)? Privacy mặc định?
5. Mẫu mô tả: nhãn tiếng Việt ("Nguồn tham khảo", "Hình ảnh", "Nhạc nền"), có `#shorts`, EXPORT có ghi đè `Video.title` bằng tiêu đề kịch bản?
6. Retention `exports`: cùng `DATA_RETENTION_DAYS` với renders hay lâu hơn?

## Phụ lục A — `library.json` mẫu

```json
{
  "version": 1,
  "tracks": [
    {
      "file": "calm-piano.wav",
      "title": "Calm Piano",
      "artist": "Jane Doe",
      "license": "CC-BY-4.0",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
      "attribution": "Nhạc: \"Calm Piano\" – Jane Doe (CC BY 4.0) https://example.com/track",
      "tags": ["cinematic", "calm", "documentary"],
      "loopable": true
    },
    {
      "file": "dark-drone.flac",
      "title": "Dark Drone",
      "artist": "Public Domain Ensemble",
      "license": "CC0-1.0",
      "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
      "tags": ["dark", "mysterious", "cinematic"],
      "loopable": true
    }
  ]
}
```

## Phụ lục B — Filtergraph đầy đủ (2 scene, F = 90 và 120, D = 7,000 s, S = 2, nhạc lặp 1 lần)

Scene 0 nhận `zoom-in`, scene 1 nhận `pan-down` (F = 120 → k = 1, `zp = ceil3(3840/(3840 − 119 − 2)) = 1.033`; kiểm: `3840 − int(3840/1.033) = 123 ≥ 121` nên không clamp):

```
ffmpeg -nostdin -hide_banner -nostats -loglevel warning -y \
  -i <scene-01.jpg> -i <scene-02.jpg> -i <scene-01.wav> -i <scene-02.wav> -stream_loop 1 -i <music.wav> \
  -filter_complex "\
[0:v]scale=2160:3840:force_original_aspect_ratio=increase:flags=lanczos:out_color_matrix=bt709:out_range=tv,crop=2160:3840,setsar=1,format=yuv444p,zoompan=z='1+0.10*on/89':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=90:s=1080x1920:fps=30,format=yuv420p,settb=1/30,setpts=N[v0];\
[1:v]scale=2160:3840:force_original_aspect_ratio=increase:flags=lanczos:out_color_matrix=bt709:out_range=tv,crop=2160:3840,setsar=1,format=yuv444p,zoompan=z='1.033':x='iw/2-(iw/zoom/2)':y='1*on':d=120:s=1080x1920:fps=30,format=yuv420p,settb=1/30,setpts=N[v1];\
[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];\
[3:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];\
[v0][v1]concat=n=2:v=1:a=0,ass=filename=subtitles.ass:fontsdir=fonts[vout];\
[a0][a1]concat=n=2:v=0:a=1,volume=2.1dB[voice];\
[4:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=7.000,volume=-9.5dB,afade=t=in:st=0:d=1,afade=t=out:st=5.000:d=2[music];\
[voice][music]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.891:attack=5:release=50:level=false[aout]" \
  -map "[vout]" -map "[aout]" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart video.tmp.mp4
```

(Đường dẫn ảnh/WAV/nhạc là argv riêng như v1; filtergraph không chứa đường dẫn.) Kết quả mong đợi: 210 frame, 7,000 s ± 0,1 s, 1 stream h264 1080×1920 + 1 stream aac 48 kHz stereo.

## Phụ lục C — Ví dụ mô tả do EXPORT sinh

```
Bạn có biết vì sao con người lại mơ, và giấc mơ đến từ đâu?

Theo dõi kênh để không bỏ lỡ tập tiếp theo.

Nguồn tham khảo:
- Why Do We Dream? – https://www.sleepfoundation.org/dreams/why-do-we-dream

Hình ảnh:
- Photo by Nguyen Van A on Pexels – https://www.pexels.com/photo/123456/
Nhạc nền: "Calm Piano" – Jane Doe (CC BY 4.0) https://example.com/track

#shorts #khoahoc #giacmo #connguoi #bonao
```

## Phụ lục D — Biến môi trường mới

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `RENDER_MOTION` | `kenburns` | `off` = chuỗi v1 |
| `RENDER_MOTION_SCALE` | `2` | 1–3, hệ số supersample trước zoompan |
| `RENDER_MOTION_PRESET` | `auto` | ép một preset cho mọi scene (test/sở thích) |
| `RENDER_TIMEOUT_MS` | `600000` | khuyến nghị `900000` khi bật motion |
| `MUSIC_LIBRARY_DIR` | `music-library` | tương đối theo `DATA_DIR` |
| `MUSIC_VOICE_TARGET_LUFS` | `-16` | mục tiêu lời đọc |
| `MUSIC_TARGET_LUFS` | `-29` | mục tiêu nhạc (−24 khi bật ducking) |
| `MUSIC_DUCKING` | `none` | `sidechain` để thử |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | | OAuth client Desktop app |
| `YOUTUBE_TOKEN_FILE` | `secrets/youtube-oauth.json` | tương đối theo `DATA_DIR`, mode 0600 |
| `YOUTUBE_DEFAULT_PRIVACY` | `private` | `unlisted`/`public` chỉ có tác dụng sau audit |
| `YOUTUBE_CATEGORY_ID` | `27` | Education |
| `YOUTUBE_UPLOAD_CHUNK_MB` | `8` | bội số 256 KiB |

## Phụ lục E — Số đo đã đo lúc thiết kế (FFmpeg 9.0.2, máy dev)

- `zoompan`: 1 frame vào + `d=90` → 90 frame; `d=300` → 300 frame; 2 frame vào → 2·d frame. Output timebase 1/30, pts 0..d−1. Biểu thức `if()`, `pow()`, `zoom` trong `x/y` parse được. Nhận `yuv444p` không chèn chuyển đổi; `rgb24` bị chuyển sang `gbrp` (không portable → dùng yuv444p).
- Benchmark 300 frame kể cả libx264 veryfast (`-benchmark`, rtime): v1 2,38 s (126 fps) · zoompan 1× yuv444p 5,58 s (54 fps) · 2× yuv420p 6,19 s (48 fps) · 2× yuv444p 10,85 s (28 fps) · 3× yuv444p 25,2 s (12 fps); zoompan riêng (không encoder) 2× yuv444p 9,85 s ≈ 33 ms/frame, đơn luồng; maxrss 427 MB.
- `crop` với biểu thức `n` ở `w/h`: checksum frame giống hệt ở n = 0/1/149/299 (chỉ x/y được tính lại mỗi frame). `perspective=eval=frame`: 25 fps cubic / 42 fps linear.
- Audio: `[voice][music]amix=inputs=2:duration=first:dropout_transition=0,volume=2` (+`alimiter`, +`sidechaincompress`) đều cho đúng 10,000 s (1 920 000 byte s16 stereo) với input 10 s. `-stream_loop 2` trên WAV 8,12 s → đúng 3 lần phát (1 169 280 byte); `atrim=end=5` → đúng 5,000 s.
- `ebur128=peak=true`: dòng tổng kết `I: -19.5 LUFS`, `LRA: 2.7 LU`, `Peak: -3.1 dBFS`; im lặng: `I: -70.0 LUFS`, `Peak: -inf dBFS`. Lời đọc Gemini thật: −19,5 LUFS, peak −3,1 dBFS; render dev hiện tại có audio im lặng (−70 LUFS, từ provider silent).

Các mục cần **xác nhận lại trên ffmpeg 4.4 (Ubuntu 22.04) và 6.1 (24.04)** ở bước đầu của C1/C2: định dạng dòng tổng kết `ebur128`, `-update 1` cho poster, `alimiter` `level=false`, và fps zoompan thực tế trên VPS.
