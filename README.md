# Trợ lý Gợi Ý Làm Bài — V3

Bản này bỏ `better-sqlite3` để tránh lỗi build native thường gặp khi deploy Node.js trên Render.

## Bản dành cho upload GitHub bằng iPhone

Các file HTML đã được đưa ra thư mục gốc để bạn không phải upload thư mục `public`.

```text
package.json
server.js
index.html
admin.html
.env.example
.gitignore
README.md
```

## 1. Chạy trên máy

Cần Node.js 20–22.

```bash
npm install
cp .env.example .env
npm start
```

Mở:

http://localhost:3000

Trang quản trị:

http://localhost:3000/admin

## 2. Cấu hình API

Mở `.env` và điền:

- `OPENAI_API_KEY=...`
- hoặc nhiều key ở `OPENAI_API_KEYS=key1,key2,key3`
- `MODEL=gpt-5.6-luna`
- `ADMIN_PASSWORD=...`
- `SESSION_SECRET=...`

Không upload `.env` lên GitHub.

## 3. Deploy Render

- Build Command: `npm install`
- Start Command: `npm start`
- Runtime: Node

Thêm các Environment Variables trên Render:

`OPENAI_API_KEY`
`OPENAI_API_KEYS` (nếu dùng nhiều key)
`MODEL`
`ADMIN_PASSWORD`
`SESSION_SECRET`
`APP_NAME`
`APP_SLUG`

Sau deploy, website sẽ có URL `https://ten-service.onrender.com`.

## 4. Quản trị

Vào `/admin` để:
- thêm/xóa key;
- bật/tắt key;
- test key;
- xem số lần dùng/lỗi;
- đổi tên website;
- đổi slug.

Lưu ý: bản V3 dùng file JSON để đơn giản và dễ chạy. Với Render Free, dữ liệu file có thể mất khi service được tạo/deploy lại. Nếu cần lưu key/settings lâu dài, nên dùng database hoặc persistent storage.
