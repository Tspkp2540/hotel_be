# API Reference

Base path: `/api/v1` · JSON UTF-8 · Body limit: 16 KiB

Machine-readable contract: [OpenAPI 3.0.3](../openapi.json)  
ผลตรวจ: [API และ Security](TESTING.md)

## รูปแบบข้อมูล

| ข้อมูล | JSON type | กติกา |
|---|---|---|
| ID | string | UUID |
| วันพัก | string | วันที่จริง `YYYY-MM-DD` |
| Timestamp | string | ISO 8601 UTC |
| ชื่อ | string | 1–150 Unicode code points หลัง trim; ห้ามมี NUL |
| อีเมล | string | Trim, lowercase, รูปแบบอีเมล; ไม่เกิน 254 ตัวอักษร |
| เบอร์โทร | string | `^\+[1-9][0-9]{1,14}$` เช่น +66812345678 |
| รหัสผ่าน | string | 12–128 Unicode code points; ไม่ trim |

Required fields ห้ามหายหรือเป็น null ปฏิเสธ unknown body/query fields และไม่แปลงชนิดข้อมูลให้อัตโนมัติ

Response สำเร็จใช้ `{ "data": ... }` ยกเว้น 204 ที่ไม่มี body Error ใช้รูปแบบเดียวกันทุก endpoint:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "ข้อมูลไม่ถูกต้อง",
    "fields": [
      {
        "field": "checkOut",
        "code": "MUST_BE_AFTER_CHECK_IN",
        "message": "วันออกต้องอยู่หลังวันเข้า"
      }
    ],
    "requestId": "df55de06-4a67-4f6a-a9b4-b416a8d72980"
  }
}
```

`fields` เป็น [] เมื่อไม่มี field error ใช้ `code` ตัดสินพฤติกรรม Frontend และใช้ requestId ติดตามปัญหา

## Authentication

Session cookie อายุคงที่ 7 วัน ชื่อ `booking_session` ใน development และ `__Host-booking_session` ใน production

Frontend ต้องส่ง `credentials: "include"` ทุก POST ต้องมี Origin ตรงกับ FRONTEND_ORIGIN รวม register/login/logout ดูการตั้งค่าใน [Security](../SECURITY.md)

## Endpoints

| Method | Path | Login | Success |
|---|---|---|---|
| POST | /auth/register | ไม่ต้อง | 201 |
| POST | /auth/login | ไม่ต้อง | 200 |
| POST | /auth/logout | ไม่ต้อง | 204 |
| GET | /auth/me | ต้อง | 200 |
| GET | /rooms | ต้อง | 200 |
| GET | /rooms/:roomId/calendar | ต้อง | 200 |
| POST | /bookings | ต้อง | 201 |
| GET | /bookings | ต้อง | 200 |
| POST | /bookings/:bookingId/cancel | ต้อง | 200 |
| GET | /bookings/requests/:requestKey | ต้อง | 200 |

### สมัครสมาชิก — POST /auth/register

```json
{
  "email": "guest@example.com",
  "password": "a-long-secure-password",
  "fullName": "สมชาย ใจดี"
}
```

คืน `data.user`: id, email, fullName, createdAt ไม่สร้าง session อัตโนมัติ อีเมลซ้ำตอบ `409 EMAIL_ALREADY_EXISTS` โดยไม่สนตัวพิมพ์เล็กใหญ่

### เข้าสู่ระบบ — POST /auth/login

Body: `email`, `password` ตามชนิดข้อมูลข้างต้น

คืน `data.user` และ `data.sessionExpiresAt` พร้อม Set-Cookie หากอีเมลไม่มีหรือรหัสผ่านผิดตอบ `401 INVALID_CREDENTIALS` ด้วยข้อความเดียวกัน

### ออกจากระบบ — POST /auth/logout

ไม่มี body ลบ session ปัจจุบันและล้าง cookie ตอบ 204 แม้ไม่มี session หรือ session หมดอายุแล้ว ไม่กระทบอุปกรณ์อื่น

### ผู้ใช้ปัจจุบัน — GET /auth/me

ไม่มี query คืน user และ sessionExpiresAt แบบเดียวกับ login ไม่ต่ออายุ session หาก session ใช้ไม่ได้ตอบ `401 UNAUTHORIZED`

### รายการห้อง — GET /rooms

ไม่มี query คืนเฉพาะห้อง active เรียง created_at ASC, id ASC

```json
{
  "data": {
    "rooms": [
      { "id": "7c71298a-ef46-457c-ab5e-9edb238a54e5", "name": "บ้านพักหลัก", "hotelName": "บ้านพักเชียงใหม่", "province": "เชียงใหม่" }
    ]
  }
}
```

ไม่มีห้องให้คืน rooms: [] ขอบเขตปัจจุบันยังไม่ใช้ pagination; hotelName:string (1–150) และ province:string (1–100) เป็น required fields จาก hotels ผ่าน rooms.hotel_id หน้าเว็บกรองข้อมูลชุดนี้ด้วย q/province ใน URL ของหน้า /rooms ไม่ใช่ query ของ API; API ยังปฏิเสธ unknown query ตามเดิม

### ปฏิทิน — GET /rooms/:roomId/calendar

Required query: `from`, `to` เป็น LocalDate ช่วง `[from, to)` ยาว 1–93 วัน

```text
/api/v1/rooms/{roomId}/calendar?from=2026-11-01&to=2026-12-01
```

```json
{
  "data": {
    "roomId": "7c71298a-ef46-457c-ab5e-9edb238a54e5",
    "timezone": "Asia/Bangkok",
    "today": "2026-11-06",
    "bookingRules": { "maxNights": 30, "maxAdvanceDays": 365 },
    "from": "2026-11-01",
    "to": "2026-12-01",
    "bookedRanges": [
      { "checkIn": "2026-11-10", "checkOut": "2026-11-12" }
    ]
  }
}
```

คืนวันจริงของ confirmed bookings ที่ทับช่วง query เรียง checkIn ไม่ตัดช่วงและไม่เปิดเผยข้อมูลผู้จอง ช่วงที่ checkout = from หรือ checkIn = to ไม่ถูกรวม

ดูวันย้อนหลังได้ ห้องไม่มีหรือ inactive ตอบ `404 ROOM_NOT_FOUND` ปฏิทินเป็น snapshot การจองต้องตรวจอีกครั้งใน transaction

### จองที่พัก — POST /bookings

```json
{
  "roomId": "7c71298a-ef46-457c-ab5e-9edb238a54e5",
  "checkIn": "2026-11-12",
  "checkOut": "2026-11-14",
  "guestName": "สมชาย ใจดี",
  "guestPhone": "+66812345678",
  "guestEmail": "guest@example.com"
}
```

คืน `data.booking`: id, roomId, checkIn, checkOut, nights, guestName, guestPhone, guestEmail, status และ createdAt รายการใหม่มี status=confirmed; lookup/replay คืนสถานะปัจจุบัน ส่วน nights เป็น integer ที่คำนวณจากวันที่

Backend อ่านผู้จองจาก session ไม่รับ userId/status จาก client สำเร็จหลัง commit เท่านั้น

| กติกา | ค่าเริ่มต้น |
|---|---|
| วันเข้า | วันนี้ถึงวันนี้ + 365 วัน ตาม Asia/Bangkok |
| วันออก | หลังวันเข้า |
| จำนวนคืน | 1–30 คืน |
| Checkout | ไม่ถือเป็นคืนที่ครอบครองห้อง |
| Config | MAX_BOOKING_NIGHTS และ MAX_ADVANCE_DAYS; อ่านค่าจริงจาก calendar metadata |

วันเข้าอยู่ภายใน advance limit ได้แม้วันออกอยู่หลัง limit

### ส่งซ้ำอย่างปลอดภัยและตรวจผล

POST /bookings รับ header **Idempotency-Key** เป็น UUID แบบ optional (Frontend ส่งทุกครั้ง) Key ผูกกับผู้ใช้และเก็บตลอดอายุ booking:

- Key เดิม + body เดิมหลัง normalize: คืน booking เดิมด้วย 201 ไม่สร้างเพิ่ม แม้ห้องปิดหรือวันเข้าผ่านไปแล้ว
- Key เดิม + body ต่างกัน: `409 IDEMPOTENCY_KEY_REUSED`
- คำขอที่ rollback ไม่ใช้ key; แก้ข้อมูลแล้วใช้ key เดิมได้
- คำขอพร้อมกันใช้ transaction lock ของคู่ user/key และ DB unique constraint
- ไม่ส่ง header: ใช้พฤติกรรมเดิม วันที่ทับกันตอบ conflict

GET /bookings/requests/:requestKey คืน `data.booking` เฉพาะเจ้าของและรับเฉพาะ UUID ไม่มี query parameters หากไม่พบหรือเป็น key ของผู้อื่น ตอบ `404 BOOKING_REQUEST_NOT_FOUND` เหมือนกัน **404 ยังไม่พิสูจน์ว่าคำขอเดิมล้มเหลว** เพราะ transaction อาจกำลังทำงาน ตรวจซ้ำหรือส่ง POST ด้วย key/body เดิมได้

รายการใหม่เป็น confirmed เสมอ หากข้อมูลถูกเปลี่ยนเป็น cancelled ในฐานข้อมูล การ lookup/replay คืนสถานะปัจจุบันตามจริง ไม่สร้างรายการทดแทน ไม่มี edit/cancel API เพิ่มเติม

## ข้อผิดพลาด

| HTTP | Code | ความหมาย |
|---|---|---|
| 400 | INVALID_JSON | JSON ผิดรูปแบบหรือมี prototype poisoning |
| 400 | INVALID_REQUEST | URL หรือคำขอระดับ router ผิดรูปแบบ |
| 401 | UNAUTHORIZED / INVALID_CREDENTIALS | Session ใช้ไม่ได้ / login ไม่สำเร็จ |
| 403 | ORIGIN_NOT_ALLOWED | Origin หายหรือไม่ตรง |
| 404 | ROOM_NOT_FOUND / NOT_FOUND | ไม่พบห้อง / resource |
| 404 | BOOKING_REQUEST_NOT_FOUND | ยังไม่พบผลที่ commit สำหรับผู้ใช้และ key นี้ |
| 409 | EMAIL_ALREADY_EXISTS | อีเมลซ้ำ |
| 409 | ROOM_UNAVAILABLE | ห้องปิดรับจอง |
| 409 | BOOKING_CONFLICT | ช่วงวันถูกจองแล้ว |
| 409 | IDEMPOTENCY_KEY_REUSED | Key เดิมใช้กับ payload ต่างกัน |
| 413 | PAYLOAD_TOO_LARGE | Body เกิน 16 KiB |
| 415 | UNSUPPORTED_MEDIA_TYPE | Endpoint ที่มี body ต้องรับ JSON |
| 422 | VALIDATION_ERROR | Body/path/query หรือกฎวันพักไม่ถูกต้อง |
| 429 | RATE_LIMITED | เกิน quota; อ่าน Retry-After เป็นวินาที |
| 500 | INTERNAL_ERROR | ข้อผิดพลาดภายใน |

Field codes: REQUIRED, INVALID_TYPE, INVALID_FORMAT, INVALID_LENGTH, UNKNOWN_FIELD, DATE_IN_PAST, TOO_FAR_IN_ADVANCE, MUST_BE_AFTER_CHECK_IN, MAX_NIGHTS_EXCEEDED, MUST_BE_AFTER_FROM และ RANGE_TOO_LARGE

เมื่อได้ BOOKING_CONFLICT ให้แจ้งผู้ใช้ โหลดปฏิทินใหม่ และเลือกช่วงวันอีกครั้ง

## Rate limits

| Scope | Key | Limit |
|---|---|---|
| Register | IP | 5 / 15 นาที |
| Login | IP + normalized email แยก quota | 20 / 15 นาที/IP และ 10 / 15 นาที/email |
| Booking | User ID รวมทุก sessions | 10 / นาที |
| General | User ID เมื่อ login; IP เมื่อ anonymous | 120 / นาที |

Server ใช้ PostgreSQL shared counters Register/login ใช้ dedicated IP quota แทน general quota Booking ผ่านทั้ง general และ dedicated user quota

Origin ที่อนุญาตอ่าน error responses ได้รวม early 429/500 โดย CORS expose Retry-After และ X-Request-Id ให้ Frontend


## ประวัติการจองของฉัน

`GET /bookings?limit=20&cursor=<booking UUID>` ต้อง login; ไม่มี request body

| Query | Type | กติกา |
|---|---|---|
| limit | integer ใน query string | ค่าเริ่มต้น 20, ช่วง 1–50; รับเฉพาะเลขฐานสิบจำนวนเต็ม ไม่มีศูนย์นำหน้า |
| cursor | string UUID, optional | ID รายการสุดท้ายของหน้าก่อนหน้า; canonicalize เป็น lowercase |

Response 200: `{ "data": { "bookings": [], "nextCursor": null } }`

แต่ละรายการใช้ข้อมูลเดียวกับ `BookingResponse.booking` และเพิ่ม `roomName: string` เป็นชื่อห้องปัจจุบัน `nextCursor` เป็น UUID string หรือ null เมื่อหมดรายการ เรียง `created_at DESC, id DESC` รวมอดีต/อนาคต ทั้ง confirmed/cancelled และห้องที่ปิดรับจองแล้ว วันพักและข้อมูลผู้เข้าพักมาจากรายการจองเดิม

เจ้าของรายการมาจาก session เท่านั้น ไม่รับ userId/filter อื่น ปฏิเสธ unknown query ด้วย 422 ไม่มี/หมดอายุ session ตอบ 401; cursor ที่ไม่มีหรือเป็นของคนอื่นตอบ 422 VALIDATION_ERROR เหมือนกัน ไม่เปิดเผยข้อมูลเจ้าของอื่น Pagination ใช้ timestamp เต็มความละเอียดใน PostgreSQL จึงไม่ทำรายการตกหล่นเมื่อสร้างในมิลลิวินาทีเดียวกัน การแบ่งหน้าไม่ใช่ snapshot; refresh เพื่อดูรายการที่สร้างใหม่

ใช้ index `bookings_user_created_idx` เดิม ไม่ต้องเพิ่ม migration และไม่มี API แก้ไขวันพักในขอบเขตนี้

## ยกเลิกการจอง

`POST /bookings/:bookingId/cancel` · Login + allowed Origin · ไม่รับ body/query

- `bookingId: string UUID`; เจ้าของมาจาก session เท่านั้น
- ก่อนวันเข้าพักตาม Asia/Bangkok: เปลี่ยน confirmed → cancelled แบบ atomic เก็บ cancelled_at/updated_at เป็น TIMESTAMPTZ และคงประวัติ/request key
- ยกเลิกแล้วส่งซ้ำ: 200 พร้อมรายการเดิม แม้เลยวันเข้าพักแล้ว ไม่เปลี่ยนเวลายกเลิกซ้ำ
- รายการไม่มีหรือของคนอื่น: 404 BOOKING_NOT_FOUND เหมือนกัน; confirmed ที่ถึง/ผ่านวันเข้าพัก: 409 CANCELLATION_NOT_ALLOWED
- ไม่มี session: 401; UUID/body/query ผิด: 422; Origin ผิด: 403; เกิน 10 attempts/min/user: 429 Retry-After (นับร่วมทุก session และผ่าน general quota ด้วย)
- Success 200: `{data:{booking:Booking}}` ใช้ชนิดเดียวกับผลการจอง ไม่มี field ภายในเพิ่มเติม
- คืนวันว่างเมื่อ UPDATE commit เพราะ exclusion constraint/index กรองเฉพาะ confirmed จึงจองวันเดิมใหม่ได้ ใช้ request key ใหม่สำหรับการจองใหม่; key เดิมยังคืนรายการ cancelled เดิม

## Response privacy

Account, room, calendar และ booking ใช้ allowlist ของ field ตาม OpenAPI ไม่ส่ง raw repository objects, password/hash, session token/hash, user_id ของ booking, request_key, SQL, role หรือ stack trace แม้ repository มี field เพิ่ม ส่วน error ที่ไม่คาดคิดตอบข้อความทั่วไปกับ requestId

ข้อมูลการจองและข้อมูลติดต่อส่งให้เจ้าของที่ login เท่านั้น Calendar ส่งแค่ช่วงวัน ไม่ส่งตัวตนผู้เข้าพัก Response ใช้ no-store ทั้ง success/error Cookie เป็น HttpOnly

ข้อมูลที่จำเป็นและส่งให้เบราว์เซอร์แล้วตรวจดูผ่าน Network ได้ จึงไม่ใช้การเข้ารหัส/ซ่อนหน้าเว็บแทนการตรวจสิทธิ์ ต้องป้องกันโดยไม่ส่งข้อมูลภายในตั้งแต่ Backend
