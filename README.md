# Tàng Thư News Worker

Cloudflare Worker trung gian cho News GUI.

## Endpoints

- `POST /source/check` — kiểm tra URL và tự xác định tên nguồn.
- `POST /source/add` — thêm nguồn trực tiếp vào `tangthu-opds`.
- `POST /subscription/add` — ghi đăng ký nguồn/tủ trực tiếp vào registry.

## Secret

Cloudflare Worker Secret:

```text
GITHUB_TOKEN
```

Token cần quyền ghi Contents vào `Zenkjt/tangthu-opds`.

## Deploy

```bash
npx wrangler deploy
```

Không đưa `GITHUB_TOKEN` vào source code.
