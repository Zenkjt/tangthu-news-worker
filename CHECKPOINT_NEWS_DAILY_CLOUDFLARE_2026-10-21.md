# CHECKPOINT — News Daily Cloudflare Cron Test — 2026-10-21

## Test schedule

Cloudflare Cron tạm thời đặt:

    45 3 * * *

Tương ứng **10:45 Asia/Ho_Chi_Minh** (UTC+7).

## Mục đích

Chỉ dùng để xác nhận Cloudflare Cron → News Worker → GitHub `repository_dispatch` → `tangthu-news-crawler` hoạt động.

## Sau khi test PASS

Đổi Cron về:

    45 23 * * *

Tương ứng **06:45 Asia/Ho_Chi_Minh**.

## Không thay đổi

- On-demand `news-subscription-changed` giữ nguyên.
- Crawler vẫn chạy `news-daily` cho Daily.
- Không thay đổi ArticleCache / Planner / EPUB / Drive.
