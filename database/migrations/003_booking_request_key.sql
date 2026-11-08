ALTER TABLE bookings ADD COLUMN request_key UUID NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_user_request_key_unique UNIQUE (user_id, request_key);
COMMENT ON COLUMN bookings.request_key IS 'Client idempotency UUID, scoped to user; retained for the lifetime of the booking. NULL for legacy requests.';
