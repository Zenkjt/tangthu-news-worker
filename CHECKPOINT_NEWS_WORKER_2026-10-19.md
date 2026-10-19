# CHECKPOINT — NEWS WORKER — 2026-10-19

## Quyết định

Không dùng GitHub Issue làm giao diện cho người dùng News.

GUI gọi một Cloudflare Worker riêng: `tangthu-news-worker`.

Worker:
- kiểm tra URL nguồn;
- tự lấy tên nguồn rõ ràng hơn từ HTML (`og:site_name`, `og:title`, `<title>`);
- thêm nguồn trực tiếp vào `config/config_news_sources.json`;
- ghi subscription trực tiếp vào `config/config_news_subscriptions.json`;
- dùng `GITHUB_TOKEN` ở Cloudflare Secret, không lộ token cho frontend.

Repo Worker:
`Zenkjt/tangthu-news-worker`

Repo registry:
`Zenkjt/tangthu-opds`

## API

`POST /source/check`
`POST /source/add`
`POST /subscription/add`

## Ví dụ

URL:

`https://vnexpress.net/chu-de/thanh-pho-ha-noi-2056`

Tên dự kiến:

`VnExpress — Hà Nội`

## Lưu ý

Worker ghi trực tiếp GitHub Contents API. Nếu sau này registry có nhiều người ghi đồng thời, cần thêm cơ chế optimistic concurrency/retry hoặc chuyển write về một queue/workflow duy nhất.
