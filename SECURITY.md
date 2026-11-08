# Security Configuration

รายละเอียดการป้องกันที่ implement แล้ว พร้อมค่าที่ต้องตั้งเมื่อ deploy ผลทดสอบอยู่ใน [งาน 06](docs/TESTING.md)

## Environment

| Variable | ค่าเริ่มต้น | กติกา |
|---|---|---|
| DATABASE_URL | Required | Runtime PostgreSQL connection; เก็บ credential นอก repository |
| FRONTEND_ORIGIN | Required | Exact HTTP(S) origin ไม่มี slash/path/query/credentials; production ต้อง HTTPS |
| NODE_ENV | development ใน example | production เปิด Secure cookie และ HSTS |
| PORT | 3001 | Server ฟัง 127.0.0.1 |
| MAX_BOOKING_NIGHTS | 30 | Positive safe integer |
| MAX_ADVANCE_DAYS | 365 | Positive safe integer |
| TRUSTED_PROXY_CIDRS | ว่าง | Comma-separated IP/CIDR ของ proxy ที่ใช้จริง |

Default ไม่เชื่อ forwarded IP ตั้ง allowlist ตาม topology จริง เช่น 127.0.0.1/32 เมื่อมี proxy ที่ตำแหน่งนั้น Proxy ต้องจัดการ forwarded headers และ HTTPS ให้ถูกต้อง Frontend/API ใช้ site เดียวกันตาม session design

## Session และ Browser

- Argon2id: memoryCost 19456 KiB, timeCost 2, parallelism 1
- Session token สุ่ม 32 bytes; เก็บเฉพาะ SHA-256 hash อายุคงที่ 7 วัน
- Cookie production: __Host-booking_session, Secure, HttpOnly, SameSite=Lax, Path=/ และไม่มี Domain
- Logout ลบเฉพาะ session ปัจจุบันและ clear cookie ด้วย attributes เดียวกัน
- ทุก POST ตรวจ Origin ก่อน parse body CORS อนุญาตเฉพาะ configured origin พร้อม credentials
- Body limit 16 KiB; strict validation ไม่ coerce input
- ชื่อบัญชี/ผู้เข้าพักห้ามมี NUL; ตอบ 422 ก่อนส่งฐานข้อมูล
- Parser ปฏิเสธ __proto__ และ constructor.prototype poisoning

## Rate Limits

Server ใช้ PgRateLimitStore และต้อง apply migration 002 ก่อนเปิด ทุก instance ใช้ PostgreSQL เดียวกัน

| Scope | Key | Quota |
|---|---|---|
| Register | IP | 5 / 15 นาที |
| Login | IP | 20 / 15 นาที |
| Login เพิ่ม | Normalized email | 10 / 15 นาที |
| Booking เพิ่ม | User ID | 10 / นาที |
| General | User ID เมื่อ login; IP เมื่อ anonymous | 120 / นาที |

ใช้ atomic upsert และ fixed window นับจาก attempt แรก Key เป็น hash ของ scope/identity ไม่มี email/IP ดิบใน bucket เมื่อเกินตอบ 429 พร้อม Retry-After หาก store ล้มเหลวตอบ 500

Register/login ใช้ dedicated IP quota แทน general quota Booking ผ่านทั้งสอง quota App factory ใช้ memory store โดย default สำหรับ tests; server.ts ส่ง PostgreSQL store เสมอ

## Logging และ Response

- Request ID เป็น UUID ที่ server สร้างเอง ไม่รับค่าจาก client
- Log เก็บ method และ request ID ไม่เก็บ raw URL/query/headers/body หรือ raw driver exceptions
- Error body ไม่เปิดเผย SQL หรือ stack trace
- Router errors ใช้ 400 INVALID_REQUEST ตาม API envelope และไม่สะท้อน raw URL
- Allowed origin อ่าน early errors ได้ และ CORS expose Retry-After/X-Request-Id
- Response headers: Cache-Control no-store, X-Content-Type-Options nosniff, Referrer-Policy no-referrer
- Production เพิ่ม HSTS max-age=31536000
- Captured-log tests ตรวจ passwords, tokens/hashes, PII และ query secrets

## Maintenance

Cleanup expired sessions/buckets ทุก 60 วินาที ไม่ทำรอบซ้อนใน process เดียว และรอรอบค้างก่อนปิด pool Session expiry ยังตรวจทุก request

Runtime role ต้องมีสิทธิ์ CRUD ตามตารางที่ใช้รวม rate_limit_buckets และแยกจาก migration role ค่า transport timeout คือ request 30 วินาที, connection 10 วินาที และ keep-alive 5 วินาที

## การตรวจและข้อจำกัด

```sh
npm run docs:check
npm run test:integration
```

OpenAPI และ response assertions ตรวจร่วมกับ security suite ยังไม่มี deployment จริงหรือ load/penetration test; browser E2E และ targeted mutation tests ผ่านแล้ว ส่วน cleanup helper ตรวจแล้ว แต่ไม่ได้รอ runtime timer tick จริง

Production migration tooling, runtime roles และ secrets/deployment setup ยังอยู่ในขั้นส่งมอบ CI workflow พร้อม แต่ยังรอ run แรกบน GitHub
