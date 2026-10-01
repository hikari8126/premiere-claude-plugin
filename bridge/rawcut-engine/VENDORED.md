# xmlcut.py — engine của tab Raw-cutter

- Nguồn: Raw-cutter 3.93 của mill2nn (github.com/mill2nn/xmlcut-releases, `app/xmlcut.py`)
- sha256 lúc copy: 8b083c31082edc736655f27e418bd79ec23a3b0c0e5c159cf17d82fb3310fdd3
- Từ đây là code của repo này, không đồng bộ upstream nữa.

## Quy tắc
- Giữ tên file có chữ `xmlcut`: lock `.xmlcut-running` chỉ coi là còn sống khi command line của pid giữ lock chứa "xmlcut".
- Không gọi `--update`, `--self-update-json`, `--check-update-json` — cập nhật đi theo bản Bridge app.
- Chỉ dùng thư viện chuẩn Python 3.8+. Cần ffmpeg + ffprobe trên PATH.
- Bridge gọi engine qua `rawcut-args.js` / `rawcut-runner.js`; protocol stdout xem `rawcut-protocol.js`.
