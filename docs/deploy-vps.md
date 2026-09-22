# Triển khai Shorts Factory lên VPS Linux

Runbook cho một máy Ubuntu 22.04/24.04 (4 vCPU, 8 GB RAM, ≥ 40 GB đĩa trống cho `data/`). Mô hình:
nginx (TLS + Basic Auth) → API Node trên `127.0.0.1:3000` → SQLite + worker chạy ffmpeg, tất cả
dưới systemd. Các file mẫu nằm trong [deploy/](../deploy/).

## 1. Chuẩn bị máy

```bash
sudo apt update
sudo apt install -y ffmpeg fonts-dejavu-core sqlite3 nginx apache2-utils rsync git
# Node 24 (hoặc ≥ 20.19)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v && ffmpeg -version | head -1
ffmpeg -hide_banner -encoders | grep -E ' (libx264|aac) '     # phải có cả hai
ffmpeg -hide_banner -filters  | grep -E ' ass '                # libass
```

Nếu `libx264` hoặc `ass` thiếu, bản ffmpeg của distro không đủ: dùng build tĩnh từ johnvansickle.com
hoặc BtbN, đặt vào `/opt/ffmpeg/bin` và trỏ `FFMPEG_PATH`/`FFPROBE_PATH` tới đó.

```bash
sudo adduser --system --group --home /opt/shorts-factory shorts
sudo mkdir -p /var/lib/shorts-factory/data /var/log/shorts-factory /var/backups/shorts-factory
sudo chown -R shorts:shorts /var/lib/shorts-factory /var/log/shorts-factory /var/backups/shorts-factory
```

## 2. Cài ứng dụng

```bash
sudo -u shorts -H bash
cd /opt/shorts-factory
git clone <repo-url> .
cp .env.example .env
openssl rand -hex 24          # dùng làm API_TOKEN nếu muốn thêm lớp token ngoài Basic Auth
nano .env
```

Các giá trị bắt buộc trong `.env`:

| Biến | Giá trị |
|------|---------|
| `HOST` | `127.0.0.1` (mặc định; không mở 0.0.0.0) |
| `DATABASE_URL` | `file:/var/lib/shorts-factory/data/shorts-factory.db` |
| `DATA_DIR` | `/var/lib/shorts-factory/data` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | để trống nếu dùng ffmpeg trên PATH |
| `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL` | provider và model AI |
| `VOICE_PROVIDER=gemini`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE` | TTS |
| `VOICE_REQUEST_DELAY_MS=2000` | tránh 429 ở free tier |
| `ASSET_PROVIDER`, `PEXELS_API_KEY` | `pexels` + key từ pexels.com/api để dùng ảnh stock (free: 200 request/giờ ≈ 20 video/giờ); để `placeholder` nếu chưa có key |
| `ASSET_FALLBACK` | `placeholder` (mặc định: scene không có ảnh stock dùng ảnh nền sinh sẵn) hoặc `fail` (job FAILED, Re-run ASSETS sau) |
| `API_TOKEN` | tuỳ chọn (≥ 16 ký tự); nếu đặt, nhập vào Settings → API token trên UI |

Sau đó:

```bash
npm ci                      # postinstall: prisma generate + cài frontend
npm run prisma:deploy       # tạo/cập nhật DB
npm run build               # dist/ (server, worker, scripts) + frontend/dist
exit
```

## 3. systemd

```bash
sudo cp deploy/shorts-factory-api.service deploy/shorts-factory-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shorts-factory-api shorts-factory-worker
systemctl status shorts-factory-api shorts-factory-worker
journalctl -u shorts-factory-worker -f
```

Worker log lúc khởi động phải có dòng `Render provider: ffmpeg (...)` và `Heartbeat every 15000 ms`.
Muốn chạy 2 worker trên máy 4 CPU thì không nên: ffmpeg dùng hết CPU, hai render song song chỉ chậm
gấp đôi.

## 4. nginx + Basic Auth + TLS + firewall

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-shorts <tên-đăng-nhập>
sudo cp deploy/nginx-shorts-factory.conf /etc/nginx/sites-available/shorts-factory
sudo ln -s /etc/nginx/sites-available/shorts-factory /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d <domain>
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

Cổng 3000 không bao giờ được mở ra ngoài; API chỉ nghe trên `127.0.0.1`.

## 5. Smoke test sau khi deploy

```bash
curl -s http://127.0.0.1:3000/api/health | jq          # status "ok", workers có 1 phần tử
cd /opt/shorts-factory && sudo -u shorts node dist/scripts/data-maintenance.js check
# Render thử 3 video giả lập bằng ffmpeg thật (không tốn quota AI/TTS): in thời gian từng stage, fps, dung lượng
sudo -u shorts npm run trial:render -- --count 3
```

Số đo tham chiếu từ máy dev (Xeon 2,5 GHz, 5 vCPU, FFmpeg 9): video 24,3 s render trong ~9 s
(~80 fps) với ảnh tĩnh (`RENDER_MOTION=off`) và ~30 s (~25 fps) với chuyển động Ken Burns mặc định
(`RENDER_MOTION=kenburns`, `RENDER_MOTION_SCALE=2`). VPS 4 vCPU nên chậm hơn 1,5–2×: nếu thấp hơn
15 fps với motion, đặt `RENDER_MOTION_SCALE=1` (nhanh ~2×) và kiểm tra CPU steal (`top`, cột `st`);
với video dài (≥ 120 s) đặt `RENDER_TIMEOUT_MS=900000`.

Trên UI: tạo 1 project, Generate, chờ COMPLETED, xem video trong khung 9:16 và tải MP4. Nếu VOICE
báo 429 nhiều lần, tăng `VOICE_REQUEST_DELAY_MS`; job tự retry 3 lần rồi mới FAILED, sau đó bấm
Re-run VOICE (các scene đã có audio được dùng lại). Trước lô lớn đầu tiên, chạy thử 10 video thật với
Gemini TTS và ghi lại tỷ lệ 429, thời gian VOICE và dung lượng; đó là căn cứ để quyết định GO.

Nếu dùng `ASSET_PROVIDER=pexels`: mỗi scene là 1 request tìm kiếm, nên 10 video ≈ 70–100 request
(trong giới hạn 200/giờ), còn lô 100 video cần chia thành nhiều đợt cách nhau ≥ 1 giờ. Khi hết quota,
scene dùng ảnh placeholder (xem dòng "Image: placeholder (placeholder fallback)" trong mục Scenes của
project) hoặc job FAILED nếu đặt `ASSET_FALLBACK=fail`; cả hai trường hợp đều Re-run ASSETS được sau
đó mà không tốn AI/TTS. Worker log `Pexels: N request(s) left` khi còn dưới 20 request. Ảnh stock
được ffmpeg chuẩn hoá thành JPEG 1080×1920 (~0,3–0,6 MB/scene) ngay ở ASSETS.

## 6. Vận hành hằng ngày

- **Health**: giám sát `GET /api/health` (không cần Basic Auth). `degraded` khi: không có worker báo
  cáo trong 90 s (`checks.worker: none`), có job RUNNING mất heartbeat (`checks.jobs: stale`, worker
  sẽ tự thu hồi trong 2 phút), hoặc đĩa dưới `HEALTH_MIN_FREE_MB` (`checks.disk: low`).
- **Backup + dọn dẹp**: `chmod +x deploy/backup.sh` (git trên Windows không giữ quyền thực thi), rồi
  `crontab -e` với nội dung [deploy/crontab.example](../deploy/crontab.example) (backup DB bằng
  `sqlite3 .backup`, mirror `audio/`, sweep hằng tuần, check hằng ngày). Chạy thử một lần bằng tay
  và kiểm tra `/var/backups/shorts-factory/db/` có file `.db` mới.
- **Job kẹt**: bấm Abort trên trang project hoặc `POST /api/jobs/<id>/abort`; project về FAILED và
  có thể Re-run. Worker chết đột ngột: job được thu hồi tự động sau `JOB_STALE_MS`.
- **Xoá project**: xoá cả file; bị từ chối (409) khi pipeline đang chạy.

## 7. Nâng cấp phiên bản

```bash
sudo systemctl stop shorts-factory-worker      # worker kill ffmpeg, trả job về PENDING rồi thoát
sudo -u shorts -H bash -c 'cd /opt/shorts-factory && git pull && npm ci && npm run prisma:deploy && npm run build'
sudo systemctl restart shorts-factory-api
sudo systemctl start shorts-factory-worker
curl -s http://127.0.0.1:3000/api/health | jq .status
```

Luôn chạy `prisma:deploy` trước khi bật worker mới: client Prisma mới có thể cần cột mới.

## 8. Khôi phục từ backup

```bash
sudo systemctl stop shorts-factory-worker shorts-factory-api
sudo -u shorts cp /var/backups/shorts-factory/db/shorts-factory-<ngày>.db /var/lib/shorts-factory/data/shorts-factory.db
sudo -u shorts rsync -a /var/backups/shorts-factory/audio/ /var/lib/shorts-factory/data/audio/
sudo systemctl start shorts-factory-api shorts-factory-worker
cd /opt/shorts-factory && sudo -u shorts node dist/scripts/data-maintenance.js check   # ảnh/render thiếu → Re-run ASSETS/RENDER
```
