# Shorts Factory Production Audit

Ngày audit: 2026-09-21. Phạm vi: pipeline RESEARCH → SCRIPT → SCENES → ASSETS → VOICE → SUBTITLES → RENDER, job engine, API, storage, DB, bảo mật, hiệu năng. Vai trò: Senior Backend / FFmpeg Pipeline / Production Reliability.

**Phương pháp (read-only, không sửa code, không cài package, không migration, không gọi API ngoài):** đọc toàn bộ `lib/jobs`, `lib/render`, `lib/ffmpeg`, `lib/assets`, `lib/voice`, `lib/subtitles`, `server/*`, `workers/*`, `prisma/*` và 244 test; truy vấn read-only DB dev `data/shorts-factory.db` (better-sqlite3 `readonly: true`) để lấy thời gian chạy thật của từng job; kiểm tra `ffmpeg -version/-encoders/-filters` của binary đang cấu hình; đo kích thước file thật trong `data/`.

## 1. Overall Status

**NO-GO cho chạy hàng loạt không giám sát (VPS, 100+ video). GO có điều kiện cho dùng cục bộ, có người trông, lô nhỏ (≤10 video/lần).**

Lý do NO-GO (tóm tắt, chi tiết ở mục 2):

| # | Vấn đề | Severity |
|---|--------|----------|
| C1 | Worker chết giữa chừng → Job kẹt `RUNNING` vĩnh viễn, Project/Video kẹt `PROCESSING`, mọi `generate`/`rerun` trả 409 mãi mãi; chỉ sửa được bằng tay trong SQLite | Critical |
| C2 | API không có xác thực, không rate-limit, `app.listen` bind mọi interface → trên VPS bất kỳ ai cũng gọi được `generate` để đốt quota Gemini/OpenAI và làm đầy đĩa | Critical |
| H1 | Không retry/backoff lỗi tạm thời và không rerun được VOICE → mỗi lần TTS 429 là cả video FAILED, phải Generate lại từ đầu (tốn lại AI credit, cache voice vô dụng). Bằng chứng DB dev: 2/5 project FAILED vì 429 | High |
| H2 | Xoá project không xoá file → orphan trong `data/assets`, `data/audio`, `data/renders` | High |
| H3 | Dừng worker (SIGTERM/kill) không dừng ffmpeg con → ffmpeg mồ côi + job kẹt | High |
| H4 | Không có endpoint lấy video output (GET result); UI chỉ hiện placeholder | High |
| H5 | 244 test không chạy FFmpeg thật lần nào → filtergraph có thể vỡ trên FFmpeg khác (Linux) mà test vẫn xanh | High |

Điểm mạnh đáng ghi nhận (không cần sửa): job claim bằng conditional UPDATE + WAL (đã test 2 worker thật); FFmpeg spawn không shell, filtergraph không chứa text/path người dùng; ASS escape kỹ và có test injection; output được ffprobe xác minh (codec, size, fps, frame ±1, duration ±100 ms) rồi mới rename atomic; tmp dir luôn dọn (`finally`), quét thư mục bỏ hoang theo mtime; path traversal bị chặn tập trung ở `LocalAssetStorage`; SUBTITLES có `inputHash` chống stale; 3 lần render thật trên FFmpeg 9.0.2/Windows đã pass đủ kiểm tra.

## 2. Critical Issues

### C1. Job kẹt RUNNING khi worker chết (Critical)

- **Impact:** Crash/OOM/reboot/`kill` trong lúc bất kỳ stage nào đang chạy → Job giữ `RUNNING`, Video `PROCESSING`, Project `PROCESSING`. `startGeneration` và `rerunStage` CAS trên `status notIn [QUEUED, PROCESSING]` nên trả 409 `GENERATION_ALREADY_ACTIVE` vĩnh viễn. Worker khởi động lại chỉ claim `PENDING`, không thu hồi. Với 100 video chạy qua đêm, một lần restart làm treo project đang chạy và không ai biết.
- **Evidence:** `lib/jobs/claim-job.ts:18-30` chỉ chọn `PENDING`; grep toàn bộ `lib/ server/ workers/` không có heartbeat/reclaim/sweeper nào; `server/services/projects.ts:31,148-151` và `server/services/videos.ts:33-39` khoá theo `Project.status`; `README.md:308-313` tự ghi nhận "recovery of jobs left RUNNING by a crashed worker" chưa làm. Không có API/CLI reset trạng thái.
- **Recommendation:** Thêm `Job.workerId` + `Job.heartbeatAt` (worker cập nhật mỗi 15–30 s trong khi xử lý). Khi worker khởi động và định kỳ: job `RUNNING` có `heartbeatAt` cũ hơn `max(RENDER_TIMEOUT_MS, 2×timeout TTS/AI) + margin` → đánh dấu `FAILED` với error `WORKER_LOST` và set video/project `FAILED` (để rerun được). Không dùng `startedAt` đơn thuần (job VOICE hợp lệ có thể chạy >10 phút). Thêm endpoint admin `POST /api/jobs/:id/abort` cho trường hợp thủ công.

### C2. API mở hoàn toàn trên mạng (Critical khi lên VPS)

- **Impact:** `POST /api/projects/:id/generate`, `POST /api/videos/:id/rerun`, `PUT /api/settings/channel-dna`, `DELETE /api/projects/:id` không có xác thực, không rate-limit. Trên VPS có IP công khai, một script quét cổng 3000 có thể tạo hàng nghìn project → đốt quota Gemini/OpenAI, chiếm worker, làm đầy đĩa (mỗi generate tạo thư mục assets/audio/renders mới), hoặc xoá dữ liệu.
- **Evidence:** `server/index.ts:9` `app.listen(env.PORT)` không chỉ định host (bind `0.0.0.0`); `server/app.ts:9-24` không có middleware auth/rate-limit; `README.md` mô tả "no authentication" là thiết kế (đúng cho local, không đủ cho VPS).
- **Recommendation:** Tối thiểu: bind `127.0.0.1` (thêm `HOST` env) và đặt sau nginx với Basic Auth hoặc IP allowlist + firewall (ufw) chỉ mở 80/443. Thêm rate-limit riêng cho `generate`/`rerun` (ví dụ 10/phút). Giữ nguyên "single-user", chỉ cần một shared token trong header nếu không muốn nginx.

### H1. Không retry lỗi tạm thời và không rerun được VOICE/ASSETS (High)

- **Impact:** Gemini TTS 429 (rất phổ biến ở free tier) → VOICE FAILED → pipeline dừng. Cách duy nhất để tiếp tục là Generate lại → version mới → chạy lại RESEARCH/SCRIPT/SCENES bằng AI (tốn credit, kịch bản khác đi), tạo thư mục mới, và cache voice (`Scene.voiceAssetId`) của video cũ không được dùng vì videoId khác. Với 100 video, tỷ lệ thất bại quan sát được là 40%.
- **Evidence:** DB dev: VOICE FAILED "Gemini TTS rate limit or quota exceeded (HTTP 429)" sau 33 s và 174 s ở 2/5 project; RESEARCH FAILED 404 "model no longer available" ở 1 project. `server/services/videos.ts:8` `RERUN_STAGES = ['SUBTITLES','RENDER']`. `lib/voice/providers/gemini.ts:95-121` một request, không retry; `lib/voice/index.ts:41` `VOICE_REQUEST_DELAY_MS` mặc định 0. `lib/voice/service.ts:138-152` cache theo scene của cùng video (sẵn sàng cho rerun nhưng không có API).
- **Recommendation:** (1) Mở rộng `RERUN_STAGES` thêm `VOICE` (prerequisite ASSETS) và `ASSETS` (prerequisite SCENES); cả hai đã idempotent trong code. (2) Retry có backoff + jitter cho 429/5xx/timeout ở tầng provider (3 lần, 5→15→45 s), vẫn fail nếu hết lượt. (3) Đặt `VOICE_REQUEST_DELAY_MS` mặc định ≥ 2000 trong `.env.example`. (4) Cân nhắc "resume" tự động: job FAILED với code tạm thời được worker tự requeue tối đa N lần (`attempts` đã có cột).

### H2. Xoá project không xoá file, xoá khi đang chạy tạo orphan (High)

- **Impact:** Mỗi `DELETE /api/projects/:id` để lại toàn bộ `data/assets/<p>`, `data/audio/<p>`, `data/renders/<p>`. Xoá khi RENDER đang chạy: ffmpeg vẫn ghi xong, `promoteOutput` ghi `video.mp4` vào `renders/<p>/<v>/` rồi `video.update` mới ném lỗi → file của project đã xoá nằm lại vĩnh viễn. Không có job dọn rác nào → đĩa đầy dần, không truy vết được.
- **Evidence:** `server/services/projects.ts:132-137` chỉ `deleteMany`; grep `removeDir|rm(` trong `lib/ server/ workers/` cho thấy chỉ `lib/assets/service.ts:72` (ASSETS tự dọn của mình) và render tmp; `lib/render/service.ts:383-385` promote trước, update DB sau.
- **Recommendation:** Trong `deleteProject`: sau khi xoá DB, `removeDir` 3 thư mục theo `projectId` (validate bằng `SAFE_SEGMENT`). Thêm script/cron "orphan sweep": liệt kê thư mục cấp `<projectId>/<videoId>` không còn trong DB → xoá. Chặn xoá khi project đang `ACTIVE` (409) hoặc abort job trước.

### H3. Dừng worker không dừng ffmpeg (High)

- **Impact:** `SIGTERM`/`SIGINT` chỉ set `running=false`; job hiện tại (kể cả ffmpeg 10 phút) chạy tiếp. Process manager (systemd mặc định 90 s, pm2, NSSM, `taskkill /F`) sau đó kill cứng node → ffmpeg mồ côi tiếp tục ghi `video.tmp.mp4` vào tmp dir, job thành `RUNNING` treo (C1). Trên Windows `SIGTERM` không tồn tại nên graceful stop chỉ có Ctrl+C. Với systemd `KillMode=control-group` ffmpeg bị kill theo cgroup nhưng job vẫn kẹt.
- **Evidence:** `workers/worker.ts:21-27`; `lib/ffmpeg/process.ts` không giữ registry child process; không có `process.on('exit')` kill con.
- **Recommendation:** Giữ tập hợp child đang chạy trong `runProcess`; trên shutdown: kill tất cả (SIGKILL), chờ `close`, đánh dấu job hiện tại `PENDING` lại (hoặc `FAILED` `WORKER_STOPPED`) trước khi `exit`. Cấu hình systemd `TimeoutStopSec` ≥ 30 s và `KillMode=mixed`.

### H4. Không có endpoint lấy video output (High)

- **Impact:** `Video.outputPath` chỉ là chuỗi trong API; frontend hiển thị "Video preview · placeholder". Người vận hành phải vào máy chủ lấy file. Không có cách tải/xem an toàn qua HTTP, không có Range để phát trực tiếp.
- **Evidence:** grep `express.static|sendFile|createReadStream` trong `server/` = 0 kết quả; `frontend/src/app/pages/project-detail/project-detail.html:28-31`.
- **Recommendation:** `GET /api/videos/:id/output`: 404 nếu `outputPath` null hoặc file không tồn tại; resolve qua `LocalAssetStorage.resolve()` (đã chặn traversal); `res.sendFile` với `Content-Type: video/mp4`, `Accept-Ranges`, `Content-Disposition: attachment; filename="<projectId>-v<version>.mp4"` (tên file sinh ra, không dùng title người dùng). Frontend: thẻ `<video controls>` khi COMPLETED.

### H5. Không có test nào chạy FFmpeg thật (High)

- **Impact:** Toàn bộ `render-service.test.ts` dùng `fakeFfmpeg`; `render.test.ts` "process runner (real spawn)" dùng `node` làm child. Một lỗi cú pháp filtergraph, tuỳ chọn không tồn tại trên bản FFmpeg khác (VPS Ubuntu ffmpeg 6.x/7.x), thiếu libass/fontconfig, hoặc font không được libass nhận trên Linux đều không bị test bắt. Bằng chứng duy nhất là 3 render thật trên Windows/FFmpeg 9.0.2 trong DB dev.
- **Evidence:** `tests/render-service.test.ts:139-179`; `tests/render.test.ts:385-434`; DB dev: 3 RENDER COMPLETED với `ffmpegVersion: 9.0.2-full_build-www.gyan.dev`, 1251 frames, `probedDurationMs 41700`.
- **Recommendation:** Test tích hợp opt-in (`test:ffmpeg`, skip khi thiếu `FFMPEG_PATH`): render 3 scene × 2 s với ảnh placeholder + WAV silent, kiểm tra kết quả bằng ffprobe thật, và kiểm tra subtitle đã được burn bằng cách so sánh hash/độ sáng vùng caption của 1 frame trích ra (`-frames:v 1`) với frame render không có ASS. Chạy test này trong bước deploy trên VPS.

### M1. Đĩa gần đầy, chưa có retention (Medium)

- **Impact:** Máy hiện tại: ổ C: 50 GB, còn 5,6 GB (89%). `MIN_FREE_DISK_BYTES` 512 MB chỉ chặn khi đã sát đáy; DB SQLite nằm cùng ổ → đầy đĩa làm hỏng cả ghi DB (WAL). Không có chính sách xoá render cũ/version cũ.
- **Evidence:** `df` trong audit; `lib/render/types.ts:31`; `lib/render/service.ts:259-273`.
- **Recommendation:** Xem mục Storage (Phụ lục A.4). Tối thiểu: cảnh báo ở health khi free < 5 GB; `DATA_DIR` sang ổ riêng; retention script.

### M2. Promote output, `outputPath` và `completeJob` là 3 bước tách rời (Medium)

- **Impact (Case D):** Sau `promoteOutput` thành công, nếu `video.update` hoặc `completeJob` ném lỗi (SQLITE_BUSY > 5 s, project bị xoá) → job FAILED, Video FAILED, nhưng `video.mp4` mới đã thay file cũ và `resultJson` không được lưu. Không hỏng dữ liệu (đường dẫn cố định, rename atomic), nhưng UI báo FAILED trong khi file hợp lệ tồn tại; rerun tốn thêm một lần encode.
- **Evidence:** `lib/render/service.ts:383-385`; `lib/jobs/process-job.ts:68-69`; `lib/jobs/complete-job.ts:24-34`.
- **Recommendation:** Chuyển `video.update({ outputPath })` vào transaction của `completeJob` (handler trả `outputPath` trong result, engine ghi cả hai trong một tx). Ghi thêm `Video.outputJobId`/`renderedAt` để UI phân biệt "có video từ lần render nào".

### M3. Không có lock ở tầng service cho RENDER cùng video (Medium)

- **Impact:** Chống chạy trùng hoàn toàn dựa vào `Project.status` (CAS) + claim CAS. Nếu bypass (sửa DB tay để gỡ kẹt C1, migration sau này, bug tương lai), hai RENDER cùng video: `removeTree(workRoot)` của job B xoá cwd của job A đang chạy → ffmpeg A lỗi ghi; `promoteOutput` last-wins.
- **Evidence:** `lib/render/service.ts:340-344`; `prisma/schema.prisma:150-168` không có unique nào trên job đang hoạt động theo video.
- **Recommendation:** Partial unique index bằng SQL thô trong migration: `CREATE UNIQUE INDEX Job_active_video ON Job(videoId) WHERE status IN ('PENDING','RUNNING')`. Chỉ xoá workdir của chính jobId mình, để sweep theo mtime lo phần còn lại.

### M4. `-loglevel error` giấu cảnh báo libass (Medium)

- **Impact:** Trên Linux nếu libass không nhận font (fontconfig thiếu, tên family khác) hoặc thiếu glyph, nó chỉ log ở mức warning rồi vẽ bằng font thay thế/tofu; job vẫn COMPLETED, video xấu mà không ai biết. `checkFont` chỉ kiểm file font, không kiểm hành vi libass runtime.
- **Evidence:** `lib/render/command.ts:58-59`; stderr chỉ được đọc khi exit ≠ 0 (`lib/render/service.ts:359-365`).
- **Recommendation:** `-loglevel warning`, luôn log tail stderr sau render (kể cả thành công) và lưu vào `resultJson.warnings`; fail hoặc cảnh báo khi stderr có `fontselect`/`Glyph ... not found`.

### M5. Đọc toàn bộ WAV vào RAM để sha256 (Medium-Low)

- **Evidence:** `lib/render/input.ts:96-99` `readFile` mỗi scene; giới hạn 50 MB × 20 scene → tối đa 1 GB lý thuyết; thực tế TTS ≈ 0,3–0,5 MB/scene.
- **Recommendation:** Hash bằng stream (`createReadStream` + `createHash`), đọc header WAV riêng.

### M6. Ảnh input không kiểm kích thước pixel (Medium, hiện chưa kích hoạt)

- **Evidence:** `lib/render/input.ts:62-77` chỉ kiểm MIME + ≤ 25 MB. PNG 25 MB có thể là 20000×20000 → ffmpeg decode 1,2 GB/frame. Hiện chỉ có placeholder 1080×1920 nên chưa xảy ra; sẽ thành rủi ro khi có stock provider (Phase B).
- **Recommendation:** Trước Phase B: đọc IHDR/SOF để lấy width/height thực và giới hạn (ví dụ ≤ 4096×8192), hoặc ffprobe ảnh trước khi render.

### M7. Dữ liệu cũ không nhất quán trong DB (Medium)

- **Evidence:** DB dev có 2 Video `COMPLETED` với `outputPath: null` và 1 project `COMPLETED` không có file (từ giai đoạn RENDER mock/placeholder). API/UI không phân biệt "COMPLETED có video" và "COMPLETED không có video". 3 Asset audio `FAILED` mồ côi còn lại từ các VOICE thất bại.
- **Recommendation:** Coi `outputPath` + file tồn tại là nguồn sự thật cho "có video"; script kiểm tra nhất quán một lần trước khi lên production; VOICE dọn asset FAILED của video ngay khi job fail (hiện chỉ dọn khi job thành công, `lib/voice/service.ts:170-171`).

### M8. Thiếu index cho truy vấn theo video/project (Medium-Low)

- **Evidence:** Index thực tế trong DB: `Job_status_createdAt_idx`, `Asset_videoId_idx`, unique của Video/Scene/Setting. Không có index `Job(videoId)`, `Job(projectId)`, `Asset(sceneId)`. `getCompletedJobResult` (`lib/jobs/results.ts:13-17`) lọc `videoId,type,status` + sort `completedAt` → full scan bảng Job; `rerunStage` `job.count` tương tự; `getProjectDetail` gọi nó theo từng video (N+1).
- **Recommendation:** Thêm `@@index([videoId, type, status, completedAt])`, `@@index([projectId, createdAt])` trên Job; `@@index([sceneId])` trên Asset. Ở 100 video (≈1000 job row) chưa đau, nhưng rẻ và tránh bất ngờ.

### M9. Vận hành: model deprecation, không log file, không health cho worker (Medium)

- **Evidence:** DB dev: RESEARCH FAILED "model gemini-2.5-flash-lite is no longer available" (đã đổi sang `gemini-3.5-flash-lite`); log chỉ `console.log`; `GET /api/health` chỉ trả `{status: ok}` của API, không biết worker sống/chết, queue sâu bao nhiêu, job RUNNING lâu nhất bao lâu.
- **Recommendation:** Health trả thêm `pendingJobs`, `runningJobs`, `oldestRunningAgeSec`, `lastWorkerHeartbeat`, `freeDiskBytes`; chạy dưới systemd/pm2 với log rotation; pin model trong `.env` và có smoke test AI/TTS 1 request khi deploy.

### L1–L5. Thấp

- L1. `lib/render/input.ts:186` cho phép ±1 ms giữa scene cuối và `Video.duration`, nhưng `lib/render/subtitles.ts:34` so `durationMs` bằng tuyệt đối → có thể `RENDER_SUBTITLES_STALE` giả nếu dữ liệu bị sửa tay. VOICE ghi cùng một số nên thực tế không xảy ra.
- L2. `Job.attempts` luôn = 1 (không có retry) → cột gây hiểu nhầm cho đến khi H1 được làm.
- L3. `SIGTERM` không có trên Windows → graceful stop chỉ với Ctrl+C; cần NSSM/Task Scheduler gửi Ctrl+C hoặc cơ chế file-flag.
- L4. Mỗi Generate tạo version + bộ thư mục mới; mỗi lần thử lại sau lỗi nhân đôi storage (liên quan H1, M1).
- L5. Worker log ra console tiếng Việt có dấu → trên console Windows codepage cũ hiển thị sai; cosmetic.

## 3. Architecture Risks

1. **`Project.status` vừa là trạng thái UI vừa là khoá phân tán.** Mọi bảo vệ chống chạy trùng (A, B) và mọi kẹt (C) đều đi qua một cột này. Khi worker chết, khoá không bao giờ được nhả. Nên tách: khoá nằm ở Job (active job per video, heartbeat), status chỉ là hệ quả.
2. **Không có khái niệm "retry-able failure".** Mọi lỗi (429, timeout, model 404, đĩa đầy, nội dung không hợp lệ) đều là FAILED chấm hết. Với TTS free tier, đây là rủi ro lớn nhất cho throughput.
3. **Rerun chỉ cho 2 stage cuối** dù ASSETS/VOICE đã idempotent. Cache voice thiết kế tốt nhưng không có đường vào.
4. **Vòng đời file không gắn với vòng đời DB.** Tạo thì gắn (atomic write, `localPath`), xoá thì không (delete project, version cũ, video FAILED). Không có retention.
5. **Một worker, tuần tự, không giới hạn thread ffmpeg.** Chạy 2 worker trên VPS 4 CPU sẽ tranh CPU (libx264 tự dùng mọi core); không có `-threads`. Nên có `RENDER_THREADS` và giới hạn 1 render đồng thời/máy.
6. **Phụ thuộc cwd.** `DATA_DIR`, `templates/documentary/fonts`, `DATABASE_URL=file:./data/...` đều tương đối theo thư mục chạy → systemd phải đặt `WorkingDirectory`; sai là lỗi khó hiểu (`RENDER_FONT_MISSING`, DB rỗng "no such table").
7. **Không có bước "verify subtitle thực sự được vẽ".** ffprobe không nhìn thấy libass; chỉ có exit code và cảnh báo bị ẩn (M4).
8. **SQLite + 5 s busy timeout** đủ cho 1 API + 1–2 worker; nếu thêm cron sweep/retention ghi DB, phải giữ transaction ngắn và write-first như hiện tại (`startGeneration` đã làm đúng).
9. **Ảnh tĩnh lặp frame** là mô hình đơn giản; khi thêm video stock/transition (Phase B), giả định "1 ảnh = N frame giống hệt", timeline `frameAt`, và ước lượng hiệu năng dưới đây đều phải làm lại.

## 4. Missing Tests

Test hiện có bao phủ tốt logic thuần và luồng với fake ffmpeg. Các kịch bản sau chưa có test nào và tương ứng với lỗi thật ở mục 2:

| # | Kịch bản | Liên quan |
|---|----------|-----------|
| T1 | Render thật với FFmpeg (opt-in): probe thật, frame count thật, subtitle thật được burn (so sánh frame) | H5 |
| T2 | Worker chết giữa job (kill process con giữa RENDER/VOICE) → job phải được thu hồi, project rerun được | C1 |
| T3 | SIGTERM/SIGINT khi ffmpeg đang chạy → ffmpeg bị kill, không orphan, job không kẹt | H3 |
| T4 | Hai RENDER job cùng video ở tầng service (không qua API) → job thứ hai không phá cwd/kết quả job thứ nhất | M3 |
| T5 | Hai request `rerun` đồng thời (như test "concurrent first generate") → đúng 1 job | Case B |
| T6 | `DELETE project` xoá cả file; delete khi job đang chạy không để orphan | H2 |
| T7 | DB fail sau promote (mock `video.update` ném lỗi) → trạng thái cuối và rerun khôi phục được | M2 |
| T8 | ENOSPC khi ghi ASS/font/tmp và khi promote → `RENDER_STORAGE_ERROR`, tmp sạch, output cũ giữ nguyên | M1 |
| T9 | Retry/backoff 429 và rerun VOICE tái dùng cache (khi H1 được làm) | H1 |
| T10 | `GET /api/videos/:id/output`: 404, Range, không traversal, không lộ path tuyệt đối | H4 |
| T11 | libass warning (font fallback) được ghi nhận/cảnh báo | M4 |
| T12 | Ảnh input kích thước bất thường (PNG 1×1, 10000×10000) → bị từ chối/không làm ffmpeg OOM | M6 |
| T13 | Fuzz `escapeAssText` (property-based: ký tự ngẫu nhiên → không mở override block, không đổi ký tự hiển thị) | Security |
| T14 | Chạy bộ test trên Linux CI (hiện chỉ chạy trên Windows dev) | Linux VPS |
| T15 | Kiểm tra nhất quán DB↔file (video COMPLETED phải có file; asset READY phải có file đúng sha256) như một script `npm run check:data` | M7 |

## 5. Production Checklist

### MUST HAVE (trước khi chạy nhiều video / lên VPS)

- [ ] Thu hồi job `RUNNING` bỏ rơi bằng heartbeat + sweeper; endpoint abort thủ công (C1)
- [ ] Worker shutdown kill ffmpeg con và trả job về `PENDING`/`FAILED` trước khi thoát (H3)
- [ ] Bind `127.0.0.1` + nginx Basic Auth/IP allowlist + firewall; rate-limit `generate`/`rerun` (C2)
- [ ] Rerun `VOICE` (và `ASSETS`); retry có backoff cho 429/5xx/timeout; `VOICE_REQUEST_DELAY_MS ≥ 2000` (H1)
- [ ] `DELETE project` xoá thư mục file; chặn xoá khi đang ACTIVE (H2)
- [ ] `GET /api/videos/:id/output` + nút xem/tải trên UI (H4)
- [ ] Test tích hợp FFmpeg thật, chạy được trên Linux; smoke render 1 video ngay sau deploy trên VPS (H5, T1, T14)
- [ ] `DATA_DIR` và DB trên volume có ≥ 20 GB trống; cảnh báo free disk trong health (M1)
- [ ] Deploy script: `prisma migrate deploy` → build → systemd với `WorkingDirectory`, `Restart=always`, `TimeoutStopSec=60`, log rotation (M9, rủi ro 6)
- [ ] Cài `ffmpeg` (có libass, libx264) và `fonts-dejavu-core` (fallback glyph) trên VPS; kiểm tra bằng `RENDER_FFMPEG_UNSUPPORTED` path
- [ ] Chạy script kiểm tra nhất quán DB↔file một lần và dọn dữ liệu cũ (M7)

### SHOULD HAVE

- [ ] `outputPath` ghi trong cùng transaction với `completeJob`; `Video.outputJobId` (M2)
- [ ] Partial unique index "1 job active / video" (M3)
- [ ] `-loglevel warning`, lưu tail stderr vào result kể cả khi thành công; cảnh báo font fallback (M4)
- [ ] Index Job(videoId,type,status,completedAt), Job(projectId,createdAt), Asset(sceneId) (M8)
- [ ] Health mở rộng: queue depth, running age, worker heartbeat, free disk; alert đơn giản (M9)
- [ ] Retention: xoá renders/audio/assets của version không phải mới nhất sau N ngày; xoá dữ liệu video FAILED sau 7 ngày; orphan sweep (M1, H2)
- [ ] Backup SQLite bằng `.backup`/`VACUUM INTO` (không copy file thô khi WAL đang mở) + `data/audio` hằng đêm
- [ ] `RENDER_THREADS`/`-threads` và giới hạn 1 render đồng thời trên mỗi máy (rủi ro 5)
- [ ] Hash WAV bằng stream (M5); kiểm kích thước pixel ảnh trước Phase B (M6)
- [ ] Dọn Asset audio `FAILED` ngay khi VOICE fail (M7)

### NICE TO HAVE

- [ ] `data/exports/<yyyy-mm-dd>-<projectId>-v<version>-<slug>.mp4` làm bản sao phục vụ upload, tách khỏi `renders/` nội bộ
- [ ] Lưu `ffmpeg` command + stderr tail vào `resultJson` để debug sau
- [ ] Metrics thời gian từng stage (đã có `startedAt/completedAt`, chỉ cần dashboard/log tổng hợp)
- [ ] Cảnh báo khi model AI/TTS trả 404/deprecated; kiểm tra cấu hình lúc worker start bằng 1 request nhỏ (tuỳ chọn vì tốn quota)
- [ ] Preset chất lượng (`veryfast/medium`, CRF) cấu hình được; thử `medium` CRF 21 để giảm dung lượng ~30% với ảnh tĩnh
- [ ] Xác định `HOST`/`PORT` qua env; `helmet`; giới hạn body JSON tường minh

## 6. Recommended Next Phase

Đề xuất chèn một phase "Hardening & Ops" trước Phase B (stock media), vì các lỗi trên nhân lên theo số video chứ không theo tính năng.

**Phase H1 — Reliability core (ước 2–3 ngày)**
1. Heartbeat + sweeper job bỏ rơi; abort endpoint; test T2.
2. Child-process registry + graceful shutdown; test T3.
3. Rerun VOICE/ASSETS; backoff 429/5xx; test T9, T5.
4. Partial unique index active-job; `outputPath` trong transaction complete; test T4, T7.

**Phase H2 — Ops & storage (ước 1–2 ngày)**
5. Bind localhost + nginx auth + rate-limit; `GET output` + UI player; test T10.
6. Delete xoá file; retention + orphan sweep script; check:data script; test T6, T15.
7. Health mở rộng; systemd units; backup script; deploy runbook.

**Phase H3 — Verification (ước 1 ngày)**
8. Test tích hợp FFmpeg thật (T1) + chạy toàn bộ test trên Linux (T14).
9. Lô thử 10 video thật trên VPS với Gemini TTS, ghi lại thời gian từng stage, tỷ lệ 429, dung lượng; hiệu chỉnh delay/backoff.
10. Quyết định GO cho lô 100 video.

Sau đó mới đến Phase B (Pexels/stock, kiểm tra pixel size, JPEG hoá ảnh), Phase C (karaoke/word timing), nhạc nền, YouTube upload.

---

## Phụ lục A — Trả lời từng mục audit

### A.1 Pipeline consistency

**Stage nào chạy lại riêng được?**

| Stage | Chạy riêng qua API | Idempotent trong code | Ghi chú |
|-------|--------------------|-----------------------|---------|
| RESEARCH / SCRIPT / SCENES | Không | Có (SCENES xoá & tạo lại scene) | Chỉ qua `generate` → version mới, tốn AI |
| ASSETS | Không | Có (`lib/assets/service.ts:63-72` xoá rows+dir rồi tạo lại) | Nên mở rerun |
| VOICE | Không | Có (cache theo `cacheKey`+sha256, `lib/voice/service.ts:194-219`) | Nên mở rerun; hiện cache không có đường dùng |
| SUBTITLES | Có (`POST /api/videos/:id/rerun`) | Có, thuần, không ghi DB | Tiếp tục sang RENDER |
| RENDER | Có | Có (tmp riêng theo jobId, rename atomic) | Không lock tầng service (M3) |

**Stage nào có nguy cơ dữ liệu stale?**
- SUBTITLES ↔ Scene: được bảo vệ bằng `inputHash` (text, timing, emphasis, ngôn ngữ, layout) tính lại lúc RENDER (`lib/render/subtitles.ts:25-39`). Tốt.
- `Scene.startTime/endTime/duration` và `Video.duration`: SCENES ghi ước lượng, VOICE ghi đè bằng số thật. Nếu VOICE fail giữa chừng, timing vẫn là ước lượng nhưng SUBTITLES/RENDER từ chối vì thiếu `voiceAssetId` và rerun bị chặn `STAGE_NOT_READY`. An toàn.
- `Video.status/outputPath`: sau render fail, `outputPath` vẫn trỏ file cũ hợp lệ trong khi status FAILED (chủ ý, nhưng UI không phân biệt). Dữ liệu cũ: 2 video COMPLETED không có outputPath (M7).
- `Project.status` là khoá: stale `PROCESSING` khi worker chết = kẹt (C1).
- `Job.resultJson` của VOICE/ASSETS chứa `localPath`; RENDER không đọc chúng mà đọc Scene/Asset → không bị stale.
- `Job.payloadJson` chụp `topic/title` lúc generate; project không sửa được nên không stale.

**Job retry có tạo duplicate không?** Không có retry tự động. `rerun` cố ý tạo Job row mới (RENDER count 2 trong test), không phải duplicate. `completeJob` chỉ chấp nhận khi còn `RUNNING` nên không thể complete hai lần. File: RENDER ghi đường dẫn cố định (ghi đè), ASSETS xoá dir trước, VOICE dọn audio lạ (`cleanupStaleAudio`) → không duplicate file trong cùng video. Duplicate duy nhất là theo thiết kế: mỗi `generate` là version mới với bộ thư mục mới (L4).

**Worker chết giữa chừng thì DB có kẹt không?** Có, vĩnh viễn (C1). Transaction SQLite atomic nên không có nửa-ghi, nhưng trạng thái `RUNNING/PROCESSING` không ai thu hồi.

### A.2 RENDER reliability

| Câu hỏi | Kết luận | Evidence |
|---------|----------|----------|
| ffmpeg spawn có timeout? | Có. `RENDER_TIMEOUT_MS` (mặc định 600 000) → `SIGKILL`; ffprobe/`-version` 60 s | `lib/ffmpeg/process.ts:67-70`, `lib/render/service.ts:355-357,376`, `lib/render/types.ts:43-45` |
| stdout/stderr có đầy buffer? | Không. Cả hai pipe luôn được đọc; stdout cắt ở 1 MB, stderr giữ 64 KB cuối; `-nostats -loglevel error` giảm output | `process.ts:72-84`, `command.ts:56-59` |
| Kill có cleanup? | Timeout: có (`finally` → `cleanupWorkDir`, xoá tới `data/tmp`). Shutdown worker: không (H3) | `service.ts:397-399,228-246` |
| Windows path? | Ổn. Path ảnh/WAV là argv riêng (không escape), ASS/fontsdir tương đối theo cwd nên tránh lỗi `C\:`; retry EBUSY khi player giữ file; `rm` retry; `.cmd/.bat` bị từ chối; `windowsHide` | `command.ts:37-52,61-62`, `output.ts:81-112`, `render/index.ts:17-24`; 3 render thật OK |
| Linux VPS? | Code portable (`statfs`, `SIGKILL`, POSIX path trong DB, parser `-filters` hỗ trợ cả FFmpeg ≤8 và 9). Chưa hề chạy/test trên Linux. Cần ffmpeg có libass+libx264, fontconfig + font fallback, chạy từ project root | `probe.ts:52-61`, `service.ts:259-273`; H5 |
| exit code | Kiểm `!== 0`, phân biệt ENOSPC, `null` = killed | `service.ts:359-365` |
| ffprobe verify | 1 video h264 1080×1920 yuv420p 30 fps, `nb_frames` ±1, 1 audio aac 48 kHz stereo, `format.duration` ±100 ms, size > 0 và ≤ 500 MB | `output.ts:30-78`, `service.ts:368-380` |
| duration video/audio mismatch | Audio = concat WAV chính xác mẫu; video = round(t×30) frame; lệch ≤ 17 ms + AAC priming ~21 ms; chấp nhận ±100 ms; DB thật: probed 41700 = expected 41700 | `timeline.ts`, `types.ts:36-41` |
| frame count mismatch | Frame tính từ mốc tuyệt đối, không tích luỹ sai số; `-r 30` không dup/drop vì input đã CFR trong tb 1/30; DB thật 1251 frame đúng | `timeline.ts:20-33`, `command.ts:37-42`, test `render.test.ts:245-260` |
| mp4 corrupt | ffprobe phải parse được JSON + đủ stream; `+faststart` hoàn tất trước khi rename; file tạm nằm trong tmp nên corrupt không bao giờ tới `renders/` | `service.ts:368-384` |

Điểm chưa kiểm được: subtitle có thực sự được vẽ hay không (libass không lộ qua ffprobe; cảnh báo bị ẩn bởi `-loglevel error`, M4).

### A.3 Concurrency

- **Case A — hai worker cùng render một video:** Không xảy ra qua luồng bình thường: mỗi project chỉ có 1 job active (CAS `Project.status`) và mỗi job chỉ 1 worker claim được (`updateMany WHERE status='PENDING'`); đã test với 2 process thật × 20 project. Ở tầng service không có lock: nếu bypass, `removeTree(workRoot)` phá cwd của render kia, `promoteOutput` last-wins, kết quả DB của job nào complete sau sẽ thắng. Không orphan file (cả hai ghi cùng path), không duplicate output. Khuyến nghị partial unique index (M3).
- **Case B — bấm rerun 2 lần liên tục:** Request 1 CAS project → QUEUED, tạo job. Request 2 CAS thất bại → 409 `GENERATION_ALREADY_ACTIVE`; nếu request 2 đến trước khi request 1 commit, SQLite serialize write nên vẫn chỉ 1 thắng (cùng cơ chế với test "concurrent first generate"). Không duplicate job. Chưa có test riêng cho 2 rerun đồng thời (T5).
- **Case C — server restart khi render:** (i) Worker nhận SIGTERM: chờ ffmpeg xong (tới 10 phút) rồi mới dừng; process manager thường kill trước → (ii) kill cứng: ffmpeg mồ côi tiếp tục ghi vào `data/tmp/render/<p>/<v>/<job>/video.tmp.mp4` rồi tự kết thúc; job kẹt RUNNING, project kẹt PROCESSING (C1, H3). Tmp dir: render tiếp theo *của cùng video* xoá ngay; render của video khác chỉ xoá khi không ai chạm > timeout + 10 phút. Nhưng vì project kẹt nên "render tiếp theo" không xảy ra nếu không sửa DB tay. API restart: vô hại (không giữ trạng thái).
- **Case D — render xong nhưng DB update fail:** File đã ở `renders/<p>/<v>/video.mp4` (rename atomic) → không corrupt, không duplicate. `video.update` fail → job FAILED, `outputPath` không đổi (trỏ cùng path nên vẫn "đúng" file mới nếu đã render trước đó, `null` nếu là lần đầu). `completeJob` fail sau khi `outputPath` đã ghi → Video FAILED nhưng `outputPath` hợp lệ, `resultJson` mất. Rerun RENDER sửa được, tốn 1 lần encode (M2). Race: có (3 bước không atomic). Lock: không. Orphan: chỉ khi project bị xoá đồng thời (H2).

### A.4 Storage

**Số liệu thật (dev):** ảnh placeholder 9,2–9,6 KB/scene; WAV TTS 24 kHz mono 16-bit = 48 KB/s (6,7 MB cho 16 file ≈ 140 s); render 41,7 s với ảnh gradient = 0,35 MB (nội dung phẳng nên x264 nén cực tốt); DB 233 KB + WAL 222 KB cho 5 project.

**Ước lượng 100 video 60 s (1 version/project):**

| Thành phần | Placeholder (hiện tại) | Stock ảnh thật (Phase B) |
|------------|------------------------|--------------------------|
| `renders/` (H.264 CRF 20 veryfast, ảnh tĩnh + phụ đề, AAC 192k) | ~0,05–0,1 GB | 100 × 15–45 MB ≈ **1,5–4,5 GB** |
| `audio/` (WAV 48 KB/s × 60 s ≈ 2,9 MB) | ~0,3 GB | ~0,3 GB |
| `assets/` | ~10 MB | 100 × 10 × 0,3–1 MB ≈ **0,3–1 GB** |
| `tmp/` | tạm thời, ≤ 2× một output (faststart ghi lại file) | ≤ ~100 MB |
| DB | ~2 MB (≈16 KB JSON/video) | ~2 MB |
| **Tổng** | **~0,4 GB** | **~2–6 GB** |

Nhân với số lần Generate lại (mỗi version là bộ đầy đủ) — với tỷ lệ fail 40% quan sát được, thực tế ×1,5–2. Ổ hiện tại còn 5,6 GB → không đủ cho 100 video ảnh thật kèm biên an toàn (M1).

**Cleanup policy hiện có:** chỉ (a) ASSETS xoá assets cũ của chính video khi chạy lại, (b) VOICE xoá audio thừa của chính video khi thành công, (c) RENDER dọn tmp. Không có cleanup theo project, version, thời gian, trạng thái.

**Retention đề xuất:** giữ render + audio của version mới nhất mỗi project vô thời hạn; version cũ: xoá render sau 30 ngày, audio/assets sau 30 ngày; video FAILED: xoá audio/assets sau 7 ngày (nhưng giữ nếu H1 cho rerun VOICE trong 7 ngày đó); `tmp/render/**` cũ hơn timeout khi worker start; orphan (không có trong DB) xoá ngay. Chạy bằng `npm run retention` qua cron hằng đêm, dry-run mặc định.

**Có cần nén ảnh trước render?** Không cho tốc độ (ffmpeg decode mỗi ảnh 1 lần rồi lặp frame; kích thước file không ảnh hưởng encode). Có cho storage và an toàn khi có stock: chuẩn hoá ảnh về đúng 1080×1920 JPEG q85 (~200–400 KB) lúc ASSETS, giới hạn pixel (M6). Với placeholder hiện tại không cần.

**Folder structure production đề xuất:**

```
/var/lib/shorts-factory/
  db/shorts-factory.db          # DATABASE_URL, volume riêng khỏi media
  data/                         # DATA_DIR (volume ≥ 20 GB trống)
    assets/<projectId>/<videoId>/scene-NN.{png,jpg}
    audio/<projectId>/<videoId>/scene-NN.wav
    renders/<projectId>/<videoId>/video.mp4       # nội bộ, ghi đè khi rerun
    exports/<yyyy-mm-dd>-<projectId>-v<version>-<slug>.mp4   # bản giao, do GET output/upload tạo
    tmp/render/<projectId>/<videoId>/<jobId>/     # phải cùng volume với renders (rename atomic)
/opt/shorts-factory/            # code, templates/documentary/fonts, .env (chmod 600)
/var/log/shorts-factory/        # api.log, worker.log (logrotate)
```

Naming hiện tại (`<kind>/<projectId>/<videoId>/scene-NN.ext`, id là cuid, validate `SAFE_SEGMENT`) giữ nguyên; chỉ thêm `exports/` theo ngày để con người tìm được.

**Backup:** DB: `sqlite3 db/shorts-factory.db ".backup /backup/sf-$(date +%F).db"` (an toàn với WAL; không `cp` file thô khi đang ghi). `data/audio`: đắt nhất để tạo lại (quota TTS) → backup hằng đêm (rsync/restic lên object storage). `data/assets`: placeholder tái tạo được, stock tải lại được → tuỳ chọn. `data/renders`: tái tạo bằng rerun RENDER từ audio+assets+DB → tuỳ chọn, backup `exports/` thay vì `renders/`. Giữ 7 bản ngày + 4 bản tuần. Kiểm tra restore mỗi tháng.

### A.5 Database

- **`Job.resultJson` có quá lớn?** Không. Thực đo: RESEARCH 1,4–2,1 KB, SCRIPT 1 KB, SCENES 2–3 KB, ASSETS 1,7–2,3 KB, VOICE 1,7 KB, SUBTITLES 6,7 KB (17 segment), RENDER 0,57 KB → ≈16 KB/video; 1000 video ≈ 16 MB. Giới hạn trên do schema: 300 segment ≈ 120 KB. Chấp nhận được. Lưu ý API `GET /api/jobs/:id` và project detail không trả `resultJson` thô (đúng).
- **Index cần thêm:** `Job(videoId, type, status, completedAt)`, `Job(projectId, createdAt)`, `Asset(sceneId)`; partial unique `Job(videoId) WHERE status IN ('PENDING','RUNNING')` (SQL thô trong migration). Index hiện có đủ cho claim (`status, createdAt`) và Scene/Video lookup.
- **Transaction cần thêm:** `outputPath` + complete trong 1 tx (M2). `deleteProject` + xoá file không thể atomic → làm theo thứ tự "đánh dấu deleting → xoá file → xoá row" hoặc chấp nhận orphan sweep. Các tx hiện có (claim, complete, fail, generate, rerun, VOICE timing, SCENES replace) đúng và đã "write-first" để tránh SQLITE_BUSY.
- **Render fail có rollback đúng?** Có ở mức file: output tạm chỉ trong tmp, `renders/` và `outputPath` không đổi, tmp bị xoá (test bao phủ). Ở mức trạng thái: Video/Project → FAILED nhưng `outputPath` cũ vẫn còn (UI không phân biệt). Không có rollback cho C1/M2.
- **FK & cascade:** `foreign_keys=1` xác nhận trong DB; Project→Video→Scene/Job cascade; Asset `videoId` cascade; Scene.assetId/voiceAssetId SetNull. Xoá project cascade ~4 bảng trong 1 statement, OK.
- **WAL:** đang bật (`journal_mode=wal`), busy timeout 5 s (`lib/db/prisma.ts:21`). Cần backup đúng cách (A.4).

### A.6 Security

**FFmpeg command**
- Shell injection: không. `spawn(command, args, { shell: false })` (`lib/ffmpeg/process.ts:54-59`); `.cmd/.bat` bị từ chối vì Node sẽ cần shell (`lib/render/index.ts:17-24`).
- Filtergraph: chỉ số và tên file cố định (`subtitles.ass`, `fonts`), không path tuyệt đối, không text người dùng (`lib/render/command.ts:37-52`; test "filtergraph has exact frame counts and no paths or text").
- Path traversal: `LocalAssetStorage.normalize/resolve` chặn `..`, absolute, drive letter, null byte (`lib/assets/storage.ts:79-104`); id thư mục phải khớp `^[A-Za-z0-9_-]+$` (`:16,26-33,59-64`); `RenderResultSchema.outputPath` từ chối path tuyệt đối/`\`/`..` (`lib/render/types.ts:81-86`). Đầy đủ.
- Subtitle escape: `{`/`}` → `\{`/`\}`; backslash trước `N/n/h` hoặc cuối chuỗi được chèn U+2060; control chars → space; text chỉ vào file ASS, không bao giờ vào argv (`lib/render/ass.ts:96-118`); có test injection và round-trip libass. Đủ cho Phase A. Đề xuất fuzz (T13).
- Filename từ user: không có; mọi tên file sinh ra (`scene-NN`, `video.mp4`), extension từ bảng MIME cố định (`lib/assets/service.ts:32-38`). Title/topic chỉ vào DB và prompt AI. Khi làm `GET output`/`exports` phải giữ nguyên tắc này (không dùng title làm filename thô).
- Bổ sung: nội dung stderr ffmpeg vào `Job.error` đã che path tuyệt đối (`stderrTail`), cắt 500 ký tự.

**API**
- `POST /api/projects/:id/generate`: Zod không cần (không body), CAS chống trùng, 404/409 đúng, không auth (C2), không rate-limit.
- `POST /api/videos/:id/rerun`: `stage` enum Zod, CAS, chỉ video mới nhất, prerequisite kiểm tra; không auth.
- `GET result`: không tồn tại (H4). Khi thêm: resolve qua storage, 404 nếu thiếu file, không redirect theo input, `Content-Disposition` với tên sinh ra.
- Khác: `express.json()` mặc định 100 KB (ổn); error handler không lộ stack; ZodError → 400; JSON parse → 400; URL nguồn research bị ràng buộc `http(s)` bằng Zod và Angular sanitize `[href]`; `.env` chứa key chỉ ở server; `GET /api/projects/:id` không trả JSON thô. Không có CORS (dùng proxy/nginx cùng origin là đúng). Thiếu: auth, rate-limit, `helmet`, bind host.

### A.7 Performance estimation (không benchmark giả)

**Điểm neo đo được (DB dev, máy audit: Xeon Gold 6133 2,5 GHz, 5 vCPU, 8 GB, Windows Server 2019, FFmpeg 9.0.2):**
- RENDER video 41,7 s, 6 scene, 1251 frame, ảnh placeholder, audio silent: **12,9 / 13,8 / 13,9 s** wall (gồm sha256 WAV, ffprobe, cleanup) ≈ 90–97 fps encode. Output 0,35 MB (nội dung phẳng).
- AI stage (Gemini 3.5 flash-lite): RESEARCH 2,5–3,6 s, SCRIPT 1,5–2,2 s, SCENES 2,6–3,5 s. ASSETS placeholder 0,4–0,6 s. SUBTITLES < 0,1 s. VOICE Gemini TTS: chưa có mẫu thành công (2 lần 429 sau 33 s và 174 s).

**Ước lượng RENDER** (libx264 `veryfast` CRF 20, 1080×1920@30, libass, ảnh tĩnh có texture thật nên chậm hơn gradient ~1,5–2×, + ~2 s overhead cố định):

| Video | Frame | VPS 4 vCPU 8 GB (60–100 fps) | Local PC 8–16 thread (150–300 fps) |
|-------|-------|------------------------------|-------------------------------------|
| 30 s | 900 | **10–17 s** | **4–8 s** |
| 60 s | 1800 | **20–32 s** | **7–14 s** |
| 90 s | 2700 | **30–47 s** | **10–20 s** |

Lưu ý: pipeline hiện tại khó tạo video 90 s (script ≤ 60 s, scene ≤ 10 × 8 s = 80 s; VOICE có thể kéo dài hơn ước lượng; giới hạn cứng 180 s). VPS dùng chung vCPU có thể chậm hơn 1,5× giờ cao điểm.

**Tài nguyên khi render:** CPU: ffmpeg ≈ 100% mọi core (libx264 auto-threads), node worker < 5%. RAM: ffmpeg 200–400 MB (10 decoder ảnh + x264 veryfast), worker 120–250 MB (WAV trong RAM, M5), API ~80 MB → 8 GB dư; 2 worker song song vẫn đủ RAM nhưng thời gian render ≈ gấp đôi. Disk I/O: ghi `video.tmp.mp4` rồi ghi lại lần 2 cho `+faststart` (2× dung lượng output tạm thời), đọc WAV/PNG một lần.

**Toàn pipeline / video (1 worker, tuần tự):** AI ≈ 8–10 s + ASSETS ≈ 0,5 s + VOICE ≈ 6–10 scene × (3–8 s + delay) ≈ 30–90 s + SUBTITLES ≈ 0 + RENDER 15–30 s → **≈ 1–2,5 phút/video**; **100 video ≈ 2–4 giờ**, giới hạn bởi quota/rate-limit TTS chứ không phải CPU. Với 429 không có backoff, thời gian thực tế cộng thêm số lần Generate lại thủ công.

### A.8 Production checklist

Xem mục 5.

---

## Phụ lục B — Trạng thái sau Phase H1 (Reliability core), 2026-09-21

Đã triển khai và xác minh: 285 test pass (244 cũ + 41 mới), typecheck và lint xanh; migration `20260921024841_job_heartbeat` đã áp lên DB dev.

| Mục audit | Thay đổi | Ở đâu |
|-----------|----------|-------|
| C1 | Heartbeat theo job (`Job.workerId`, `Job.heartbeatAt`). Worker thu hồi job kẹt lúc khởi động và mỗi `JOB_RECOVERY_INTERVAL_MS`: về `PENDING` khi `attempts < JOB_MAX_ATTEMPTS`, ngược lại `FAILED` cùng video/project. Job của worker cũ (không heartbeat) được xét theo `startedAt` | `lib/jobs/heartbeat.ts`, `lib/jobs/recover-jobs.ts`, `workers/worker.ts` |
| C1 | `POST /api/jobs/:id/abort` huỷ job `PENDING`/`RUNNING` (video/project → `FAILED`); worker nhận ra ở heartbeat kế tiếp, kill ffmpeg, bỏ kết quả | `server/services/jobs.ts`, `server/routes/jobs.ts` |
| H3 | Registry child process; SIGINT/SIGTERM/SIGHUP/Ctrl+Break/IPC `shutdown` kill ffmpeg, requeue job đang chạy (không tính attempt) rồi thoát; `WORKER_STOP_TIMEOUT_MS` chặn treo; handler `exit` kill con lần cuối | `lib/ffmpeg/process.ts`, `lib/jobs/requeue-job.ts`, `lib/jobs/process-job.ts`, `workers/worker.ts` |
| H1 | Rerun thêm `ASSETS` và `VOICE`; retry backoff + jitter cho 429/5xx/timeout/network ở Gemini AI, Gemini TTS, OpenAI, tôn trọng `Retry-After` và `RetryInfo.retryDelay` (`PROVIDER_RETRY_ATTEMPTS/BASE_MS/MAX_MS`, mặc định 4 lần: 5 s, 15 s, 45 s); `.env.example` đặt `VOICE_REQUEST_DELAY_MS=2000` | `lib/retry.ts`, `lib/ai/providers/gemini.ts`, `lib/ai/providers/openai.ts`, `lib/voice/providers/gemini.ts`, `server/services/videos.ts` |
| M2 | `Video.outputPath` ghi trong cùng transaction với `completeJob`; RENDER service không ghi DB nữa | `lib/jobs/complete-job.ts`, `lib/jobs/process-job.ts`, `lib/render/service.ts` |
| M3 | Guard "1 job active / video" trong `createJob` (cùng transaction, dưới write lock của SQLite) → API 409 `JOB_ALREADY_ACTIVE`. Chọn cách này thay vì partial unique index vì Prisma không mô hình hoá được partial index (rủi ro drift) | `lib/jobs/create-job.ts`, `server/http/errors.ts` |
| — | `failJob`/`completeJob` bỏ qua job không còn `RUNNING` (đã huỷ hoặc thu hồi); `Job.error` được xoá khi job hoàn tất | `lib/jobs/fail-job.ts`, `lib/jobs/complete-job.ts` |

Test mới: `tests/retry.test.ts` (11), `tests/provider-retry.test.ts` (13), `tests/recovery.test.ts` (14, gồm 2 kịch bản worker thật: kill -9 giữa VOICE rồi worker khác thu hồi và hoàn tất pipeline; IPC `shutdown` giữa job, không job nào kẹt `RUNNING`, worker kế tiếp chạy tiếp), 3 test rerun mới trong `tests/render-service.test.ts` (rerun VOICE tái dùng cache sau 429, rerun ASSETS, rerun đồng thời chỉ tạo 1 job). Đóng T2, T3, T5, T7, T9 ở mục 4; T4 được đóng bằng guard `createJob`.

Chưa làm, chuyển sang Phase H2/H3 theo mục 6: C2 (auth, bind localhost, rate-limit), H2 (xoá file khi xoá project, retention, orphan sweep), H4 (GET output + UI), H5 (test FFmpeg thật, chạy trên Linux), M1, M4–M9. Kết luận GO/NO-GO ở mục 1 vì thế chưa đổi.

Lưu ý vận hành: khi deploy phải chạy `npm run prisma:deploy` trước khi khởi động worker mới (client Prisma mới cần hai cột mới). Worker và API phải được khởi động lại để dùng code H1; dev server chạy `tsx watch` tự reload nhưng worker thì không.

---

## Phụ lục C — Trạng thái sau Phase H2 (Ops & storage), 2026-09-21

| Mục audit | Thay đổi | Ở đâu |
|-----------|----------|-------|
| C2 | API bind `HOST` (mặc định `127.0.0.1`); `API_TOKEN` tuỳ chọn (Bearer / `X-API-Key`, `/api/health` mở, route output nhận `?token=` cho thẻ `<video>`); rate limit request ghi (`RATE_LIMIT_PER_MINUTE`, 429 + `Retry-After`); `trust proxy` loopback cho nginx; nginx Basic Auth + TLS + ufw trong runbook | `server/config/env.ts`, `server/http/auth.ts`, `server/http/rate-limit.ts`, `server/app.ts`, `deploy/nginx-shorts-factory.conf` |
| H4 | `GET /api/videos/:id/output` stream MP4 có Range, tên file theo id, `?download=1`; UI có player 9:16, nút Download, Re-run 4 stage, Abort job đang chạy; ô nhập API token ở Settings (localStorage + interceptor) | `server/services/videos.ts`, `server/routes/videos.ts`, `frontend/src/app/pages/project-detail/*`, `frontend/src/app/services/api-token.ts`, `video.service.ts`, `job.service.ts` |
| H2 | `DELETE project` xoá `assets/ audio/ renders/ tmp/render` của project, từ chối 409 `PROJECT_ACTIVE` khi pipeline đang chạy; script `data:check` (DB↔file: video không có file, asset thiếu/sai size/sai sha256, asset kẹt, orphan dir, file .tmp) và `data:sweep[:apply]` (orphan, tmp bỏ hoang, retention version cũ theo `DATA_RETENTION_DAYS`, không bao giờ đụng version mới nhất hay file lạ) | `server/services/projects.ts`, `lib/assets/storage.ts` (`projectDirs`), `lib/maintenance/*`, `scripts/data-maintenance.ts` |
| M9 | `/api/health` trả `ok/degraded` + queue (pending, running, job lâu nhất, job mất heartbeat), workers còn sống (presence 30 s, ngưỡng 90 s), free disk so với `HEALTH_MIN_FREE_MB`; luôn HTTP 200 để monitor đọc body | `server/services/health.ts`, `lib/jobs/worker-presence.ts`, `workers/worker.ts` |
| Ops | Runbook VPS (Ubuntu, ffmpeg + fonts-dejavu, systemd 2 unit với `KillMode=mixed`/`TimeoutStopSec=60`, nginx, certbot, ufw, smoke test, nâng cấp, khôi phục), backup `sqlite3 .backup` + rsync audio, crontab mẫu (backup đêm, sweep tuần, check ngày) | `docs/deploy-vps.md`, `deploy/*` |
| M1 | Cảnh báo disk qua health; retention qua sweep. Việc chuyển `DATA_DIR`/DB sang volume riêng là bước cấu hình trong runbook | `docs/deploy-vps.md` |

Xác minh: test backend mới `tests/ops.test.ts` (6: token, rate limit, output + Range + 404, xoá project kèm file/409, health) và `tests/maintenance.test.ts` (2: mọi loại issue của check; sweep dry-run/apply/idempotent, giữ version mới nhất và file lạ); test cũ `DELETE` cập nhật; frontend `ng lint`, `ng build`, `ng test` (vitest, thêm spec cho interceptor token). Chạy `data:check` trên dữ liệu dev thật phát hiện đúng 2 video COMPLETED không có file (M7); sweep dry-run không có gì để xoá. Đóng T6, T10, T15 ở mục 4.

Chưa làm, chuyển Phase H3/B: H5 (test tích hợp FFmpeg thật, chạy test trên Linux), M4 (loglevel warning + lưu stderr), M5 (hash WAV stream), M6 (kiểm pixel ảnh, trước Phase B), M8 (index Job/Asset). Kết luận GO/NO-GO: sau H1 + H2, các mục MUST còn lại là H5 và việc thực thi runbook trên VPS thật (Phase H3); GO cho lô 100 video chỉ nên quyết định sau lô thử 10 video ở H3.

---

## Phụ lục D — Trạng thái sau Phase H3 (Verification), 2026-09-21

| Mục audit | Thay đổi | Ở đâu |
|-----------|----------|-------|
| H5 / T1 | Test tích hợp với FFmpeg **thật** (tự bỏ qua khi không tìm thấy ffmpeg/ffprobe): chạy cả pipeline mock rồi render bằng ffmpeg từ `FFMPEG_PATH`/PATH, kiểm tra ffprobe thật, frame count, duration, và **trích 1 frame giữa caption đầu** để đếm pixel sáng trong dải phụ đề (phải có) và vùng trên (phải không có) → xác nhận phụ đề thực sự được burn bằng font đóng gói. Chèn emoji vào scene 1 để kiểm tra đường cảnh báo glyph thiếu | `tests/render-ffmpeg.test.ts` |
| T14 | Workflow CI GitHub Actions trên Ubuntu: cài `ffmpeg` + `fonts-dejavu-core`, typecheck, lint, build, toàn bộ test backend (gồm test FFmpeg thật và worker thật), test frontend. Chưa chạy được ở đây (không có GitHub runner), cần push để xác nhận | `.github/workflows/ci.yml` |
| Lô thử | Script `npm run trial:render -- --count N`: N project qua toàn pipeline với AI mock + narration silent + ffmpeg thật trên DB và thư mục tạm, in thời gian từng stage, fps, dung lượng, rồi `checkData`. Không tốn quota, chạy được trên VPS trước lô thật | `scripts/render-trial.ts` |
| M4 | `-loglevel warning`; mọi dòng FFmpeg/libass in ra khi render thành công được log (`RENDER warning (font|ffmpeg)`) và lưu vào `resultJson.warnings` cùng cảnh báo của font check; dòng nhiễu vô hại "Guessed Channel Layout" (WAV không có channel mask) bị lọc | `lib/render/command.ts`, `lib/render/service.ts`, `lib/render/types.ts` |
| M8 | Index `Job(videoId, type, status, completedAt)`, `Job(projectId, createdAt)`, `Asset(sceneId)`; migration `20260921040000_job_asset_indexes` đã áp lên DB dev | `prisma/schema.prisma`, `prisma/migrations/` |
| Rủi ro 5 | `RENDER_THREADS` giới hạn thread libx264 khi máy dùng chung (mặc định 0 = tất cả core) | `lib/render/index.ts`, `lib/render/command.ts` |
| M5 | Xem lại: `loadRenderInput` đọc WAV **tuần tự từng scene**, buffer được giải phóng sau mỗi scene, nên đỉnh RAM là 1 file ≤ 50 MB chứ không phải 1 GB như audit ước lượng. Không cần sửa; ghi nhận audit đã ước lượng quá tay | `lib/render/input.ts` |
| CI ổn định | `tests/concurrency.test.ts` ép `VOICE_REQUEST_DELAY_MS=0` cho worker con, để `.env` của máy (ví dụ 2000 ms) không làm test vượt timeout | `tests/concurrency.test.ts` |

**Số đo thật trên máy dev** (Xeon Gold 6133 2,5 GHz, 5 vCPU, 8 GB, Windows Server 2019, FFmpeg 9.0.2, ảnh placeholder, narration silent, 7 scene, 24,3 s, 729 frame):

| Nguồn | RENDER | Tốc độ | Dung lượng | Ghi chú |
|-------|--------|--------|------------|---------|
| `tests/render-ffmpeg.test.ts` | 7,0 s (gồm probe + trích frame) | ~104 fps | 198 KB | 8 cảnh báo khi có emoji (font check + libass fallback) |
| `trial:render --count 3` | 5,3 / 5,6 / 5,7 s | 127–136 fps, trung bình 131 | 0,19 MB | toàn pipeline 6,1 s/video; ASSETS 0,43 s, các stage khác < 0,1 s; `checkData` sạch |
| `trial:render --count 1` (sau khi lọc nhiễu) | 6,6 s | 111 fps | 0,19 MB | 0 cảnh báo |

So với ước lượng ở A.7 (VPS 4 vCPU: 60–100 fps): máy dev đạt 104–136 fps với nội dung phẳng; ảnh stock thật sẽ chậm hơn 1,5–2×, vẫn trong khoảng đã ước lượng.

Xác minh: toàn bộ suite backend 294 test pass (293 sau H2 + test FFmpeg thật), typecheck + lint xanh; test mới `tests/render-ffmpeg.test.ts` chạy thật trên máy này, `tests/render.test.ts` cập nhật cho `-loglevel warning` và `-threads`. Đóng T1 (trên Windows; Linux qua CI), T11 (cảnh báo font được ghi nhận), M4, M8. Còn lại của roadmap H3 chỉ là việc **thực thi trên VPS thật**: push để CI chạy trên Ubuntu, deploy theo runbook, `trial:render` rồi lô thử 10 video với Gemini TTS. Sau đó mới có cơ sở đổi kết luận mục 1 sang GO.

---

## Phụ lục E — Trạng thái sau Phase B (stock media), 2026-09-21

| Mục audit | Thay đổi | Ở đâu |
|-----------|----------|-------|
| Phase B | Provider **Pexels** (`ASSET_PROVIDER=pexels`, `PEXELS_API_KEY`): 1 tìm kiếm portrait/scene từ keyword của `visualPrompt`; chỉ ảnh (RENDER ghép ảnh tĩnh); tải https từ `images.pexels.com` qua `openRemote` (allow-list host, giới hạn 30 MB, không theo redirect), CDN được yêu cầu crop sẵn 1080×1920; 429/5xx/mạng retry bằng backoff chung (`PROVIDER_RETRY_*`, đọc `Retry-After` và `X-Ratelimit-Reset`); 401/403 báo sai key, không retry; log khi còn < 20 request; attribution (photographer, pageUrl, license) lưu trong metadata, API project trả `scene.visual` và trang project hiện credit kèm link | `lib/assets/providers/pexels.ts`, `lib/assets/index.ts`, `server/services/projects.ts`, `frontend/src/app/pages/project-detail/project-detail.html` |
| M6 / T12 | Đọc header PNG/JPEG/WebP không decode (`parseImageInfo`/`readImageInfo`: 64 KB đầu, mở rộng khi SOF nằm sau ICC/EXIF lớn); giới hạn ≤ 12 000 px/cạnh, ≤ 40 Mpx, ≥ 16 px; định dạng thật phải khớp MIME khai báo. ASSETS từ chối ứng viên hỏng/quá lớn (Asset FAILED + lý do, xoá file, thử ứng viên kế; fallback `INVALID_IMAGE`); RENDER kiểm lại (`RENDER_INVALID_IMAGE`) nên file đặt tay cũng không làm ffmpeg cấp phát hàng GB | `lib/assets/image-info.ts`, `lib/assets/service.ts`, `lib/render/input.ts`, `lib/render/errors.ts` |
| Chuẩn hoá JPEG (A.4) | Ảnh lớn hơn 1080×1920 hoặc nặng hơn 2 MB được ffmpeg scale (cover) + crop giữa thành JPEG 1080×1920 q3 qua `runProcess` (bị kill khi worker dừng; `ASSET_NORMALIZE_TIMEOUT_MS` mặc định 60 s); kết quả được đọc lại header để xác nhận đúng 1080×1920 JPEG rồi ghi atomic, file gốc bị xoá, `metadataJson.original` giữ kích thước/sha256 gốc, `sha256` là của file cuối (khớp `data:check`). Placeholder và ảnh CDN đã đúng cỡ không qua ffmpeg → provider offline và test không cần ffmpeg. Dùng `yuvj420p` để chạy được trên ffmpeg 4.4 (Ubuntu 22.04) tới 9.0. Đo thật: PNG 4000×6000 → JPEG 1080×1920 trong 0,37 s | `lib/assets/normalize.ts`, `lib/assets/service.ts` |
| Vận hành lô | `ASSET_FALLBACK=fail`: scene không có ảnh stock dùng được → job FAILED với mã `NO_CANDIDATES`/`PROVIDER_ERROR`/`DOWNLOAD_FAILED`/`INVALID_IMAGE` và thông báo nêu scene + cách xử lý, thay vì placeholder; Re-run ASSETS sau khi hết giờ quota (cache VOICE giữ nguyên). Lỗi cấu hình (ffmpeg không chạy được) làm job fail ngay thay vì thử 5 ứng viên rồi placeholder. `ASSET_SEARCH_LIMIT` (1–80, mặc định 15) | `lib/assets/service.ts`, `lib/assets/index.ts`, `.env.example` |
| Worker log | `Asset provider: pexels (storage …, normalize: ffmpeg, fallback: placeholder)` để thấy cấu hình lúc khởi động | `workers/worker.ts` |

Giới hạn Pexels free: 200 request/giờ, 20 000/tháng → 1 request/scene ≈ 20–25 video/giờ; lô 100 video cần ≥ 4 giờ hoặc chia nhiều đợt. Retry chỉ chờ tối đa `PROVIDER_RETRY_MAX_MS` (60 s) nên khi hết quota giờ, scene sẽ fallback placeholder (mặc định) hoặc job fail (`ASSET_FALLBACK=fail`); cả hai đều Re-run ASSETS được mà không tốn AI/TTS. Storage ước lượng ở A.4 cho ảnh thật giảm: mỗi scene ~0,3–0,6 MB JPEG thay vì 1–15 MB gốc.

Chưa làm (ngoài phạm vi Phase B): video clip stock (RENDER chỉ ghép ảnh tĩnh; cần timeline mới, rủi ro 9), M7 (dọn asset audio FAILED khi VOICE fail), T13 (fuzz ASS). Chưa gọi API Pexels thật (máy dev không có key): mapping response dựa trên tài liệu Pexels API v1 (`photos[].src.original`, `X-Ratelimit-*`), cần 1 project thử thật trước khi dùng cho lô.

Xác minh: test mới `tests/image-info.test.ts` (parser PNG/JPEG/WebP kể cả progressive, fill byte, APP segment > 64 KB; giới hạn; normalizer với runner giả), `tests/pexels-provider.test.ts` (fetch giả: request/header, mapping + crop params, lọc ảnh nhỏ/trùng, retry 429 Retry-After và 5xx, 401/400 không retry, JSON hỏng, download chỉ từ images.pexels.com, cấu hình env), `tests/assets-ffmpeg.test.ts` (ffmpeg thật, tự bỏ qua khi thiếu: PNG 1920×1080 → JPEG 1080×1920, file hỏng → INVALID_IMAGE không lộ path, ASSETS + RENDER mock chấp nhận JPEG chuẩn hoá), `tests/assets-pipeline.test.ts` thêm 6 test (file không phải ảnh → ứng viên kế, quá cỡ/sai MIME → fallback INVALID_IMAGE không để file thừa, chuẩn hoá bằng normalizer giả, bỏ qua khi đã đúng cỡ, normalizer sai cỡ → fallback, lỗi cấu hình → job fail, `ASSET_FALLBACK=fail`), `tests/render-service.test.ts` thêm 2 case `RENDER_INVALID_IMAGE`. Toàn bộ suite backend: **324 test pass, 0 fail** (294 sau H3 + 30 mới), typecheck + lint xanh. Frontend build + 5 test pass; API dev thật trả `scene.visual` cho project cũ (placeholder, không credit). Đóng M6, T12. Bước tiếp theo cần người dùng: đặt `PEXELS_API_KEY`, chạy 1 project với `ASSET_PROVIDER=pexels`, xem credit trên trang project và `npm run data:check`; rồi mới tới CI Ubuntu, deploy, `trial:render`, lô thử 10 video và quyết định GO.

---

## Phụ lục F — Trạng thái sau Phase C1 (Ken Burns motion), 2026-09-21

Theo thiết kế [pipeline-design.md](pipeline-design.md) mục 4.1 và 9.

| Hạng mục | Thay đổi | Ở đâu |
|----------|----------|-------|
| Motion | `lib/render/motion.ts` (thuần): preset theo chu kỳ zoom-in / pan / zoom-out / pan lệch theo sha256(videoId), trục và hướng pan từ bit của hash → hai scene liền nhau không lặp, rerun tái tạo y hệt; biểu thức `zoompan` cho zoom 1,00↔1,10 và pan theo bước nguyên (2 px/frame khi scene < 120 frame ở scale ≥ 2, còn lại 1 px/frame) với zoom `ceil3(axis/(axis − travel − 2))` để cửa sổ crop không bao giờ chạm biên; scene quá dài để pan (travel > 25 % trục) chuyển sang zoom cùng chiều | `lib/render/motion.ts` |
| Chuỗi render | Khi bật: `scale=<1080S>:<1920S>:…:flags=lanczos,crop,setsar,format=yuv444p,zoompan=…:d=<F>:s=1080x1920:fps=30,format=yuv420p,settb=1/30,setpts=N` (không `loop`); tắt: chuỗi Phase A byte-for-byte. `REQUIRED_FILTERS` += `zoompan` | `lib/render/command.ts` |
| Cấu hình | `RENDER_MOTION=kenburns\|off` (mặc định kenburns), `RENDER_MOTION_SCALE=1–3` (mặc định 2), `RENDER_MOTION_PRESET=auto\|<preset>`; `RenderServices.motion` (không đặt = off, nên test fake runner cũ không đổi) | `lib/render/index.ts`, `lib/render/types.ts` |
| Kết quả | `RenderResult` thêm `motion`, `motionScale`, `motionPresets` có default → result cũ vẫn parse; worker log `motion: kenburns ×2`; log RENDER liệt kê preset từng scene | `lib/render/types.ts`, `lib/render/service.ts`, `workers/worker.ts` |

**Số đo thật máy dev** (FFmpeg 9.0.2, video mock 24,3 s / 729 frame / 7 scene, ảnh placeholder):

| Cấu hình | RENDER | fps | Ghi chú |
|----------|--------|-----|---------|
| `RENDER_MOTION=off` (`trial:render`) | 9,3 s | 79 | máy đang chạy dev server + worker |
| `RENDER_MOTION=kenburns` scale 2 (`trial:render`) | 29,6 s | 25 | 0,27 MB thay vì 0,19 MB (ảnh chuyển động nén kém hơn) |
| Test ffmpeg thật, preset `pan-down` | 30,9 s | 24 (kể cả probe) | dải sáng dịch **108,5 px** qua scene 1, đúng 729 frame, probe ±100 ms đạt |

Khớp benchmark lúc thiết kế (28 fps cho 300 frame không có overhead). Ước lượng VPS 4 vCPU: 12–20 fps → Short 45 s ≈ 70–110 s; nếu dưới 15 fps dùng `RENDER_MOTION_SCALE=1`.

Xác minh: `tests/render.test.ts` thêm 6 test (chuỗi zoompan, preset deterministic/luân phiên, biểu thức từng preset, bất đẳng thức không chạm biên cho mọi độ dài 1–600 frame × scale 1–3 × hai trục, fallback scene dài, result cũ parse được, cấu hình env), `tests/render-service.test.ts` thêm 1 test fake runner (một `zoompan` mỗi scene, không `loop`, preset ghi vào result, preset ép, tắt), `tests/render-ffmpeg.test.ts` thêm test ffmpeg thật (ảnh có dải sáng, `pan-down` → tâm dải dịch ≥ 20 px; `off` → không dịch; frame-exact). Toàn bộ suite backend: **333 test pass, 0 fail** (324 sau Phase B + 9 mới, ~6 phút vì hai render ffmpeg thật có motion), typecheck + lint xanh; `trial:render` off/on sạch `checkData`. Chưa làm trong C1 (theo thiết kế): dễ nhất là easing smoothstep cho zoom; VPS chưa đo. Tiếp theo: Phase C2 (nhạc nền).
