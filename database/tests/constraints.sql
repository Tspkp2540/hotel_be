\set ON_ERROR_STOP on
-- This file only runs inside the disposable booking_test database.
CREATE FUNCTION pg_temp.assert_true(value BOOLEAN, label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ BEGIN
  IF value IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

CREATE FUNCTION pg_temp.expect_error(statement TEXT, expected_state TEXT, expected_constraint TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actual_state TEXT; actual_constraint TEXT;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE, actual_constraint = CONSTRAINT_NAME;
    IF actual_state <> expected_state OR (expected_constraint IS NOT NULL AND actual_constraint <> expected_constraint) THEN
      RAISE EXCEPTION 'Wrong error: % / %, expected % / %', actual_state, actual_constraint, expected_state, expected_constraint;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'Expected error %, statement succeeded', expected_state;
END $$;

INSERT INTO users(id,email,password_hash,full_name) VALUES
('10000000-0000-4000-8000-000000000001','guest@example.com','fixture-only-not-real-password-hash','Guest');

SELECT pg_temp.expect_error($q$INSERT INTO users(email,password_hash,full_name) VALUES ('GUEST@example.com','fixture','Guest')$q$, '23505', 'users_email_lower_uidx');
SELECT pg_temp.expect_error($q$INSERT INTO users(email,password_hash,full_name) VALUES ('new@example.com','fixture','   ')$q$, '23514', 'users_name_nonempty');
SELECT pg_temp.expect_error($q$INSERT INTO users(email,password_hash,full_name) VALUES ('new@example.com','fixture',repeat('a',151))$q$, '22001');
SELECT pg_temp.expect_error($q$INSERT INTO users(email,password_hash,full_name) VALUES (NULL,'fixture','Guest')$q$, '23502');

INSERT INTO sessions(user_id,token_hash,expires_at) VALUES
('10000000-0000-4000-8000-000000000001',repeat('a',64),CURRENT_TIMESTAMP + INTERVAL '7 days');
SELECT pg_temp.expect_error($q$INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ('10000000-0000-4000-8000-000000000001','bad',CURRENT_TIMESTAMP + INTERVAL '1 day')$q$, '23514', 'session_hash_valid');
SELECT pg_temp.expect_error($q$INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ('10000000-0000-4000-8000-000000000001',repeat('b',64),CURRENT_TIMESTAMP)$q$, '23514', 'session_expiry_valid');
SELECT pg_temp.expect_error($q$INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ('10000000-0000-4000-8000-000000000001',repeat('a',64),CURRENT_TIMESTAMP + INTERVAL '1 day')$q$, '23505', 'sessions_token_hash_unique');
SELECT pg_temp.expect_error($q$INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ('90000000-0000-4000-8000-000000000001',repeat('b',64),CURRENT_TIMESTAMP + INTERVAL '1 day')$q$, '23503', 'sessions_user_fk');

CREATE FUNCTION pg_temp.book(arrival DATE, departure DATE, room UUID DEFAULT '7c71298a-ef46-457c-ab5e-9edb238a54e5', state booking_status DEFAULT 'confirmed') RETURNS VOID
LANGUAGE plpgsql AS $$ BEGIN
INSERT INTO bookings(user_id,room_id,check_in,check_out,guest_name,guest_phone,guest_email,status,cancelled_at)
VALUES ('10000000-0000-4000-8000-000000000001',room,arrival,departure,'Guest','+66812345678','guest@example.com',state,CASE WHEN state='cancelled' THEN CURRENT_TIMESTAMP END);
END $$;

SELECT pg_temp.book('2030-01-10','2030-01-12');
SELECT pg_temp.expect_error($q$SELECT pg_temp.book('2030-01-10','2030-01-12')$q$, '23P01', 'prevent_overlapping_bookings');
SELECT pg_temp.expect_error($q$SELECT pg_temp.book('2030-01-09','2030-01-11')$q$, '23P01', 'prevent_overlapping_bookings');
SELECT pg_temp.expect_error($q$SELECT pg_temp.book('2030-01-11','2030-01-13')$q$, '23P01', 'prevent_overlapping_bookings');
SELECT pg_temp.expect_error($q$SELECT pg_temp.book('2030-01-09','2030-01-13')$q$, '23P01', 'prevent_overlapping_bookings');
SELECT pg_temp.expect_error($q$SELECT pg_temp.book('2030-01-10','2030-01-11')$q$, '23P01', 'prevent_overlapping_bookings');
SELECT pg_temp.expect_error($q$SELECT pg_temp.book('2030-01-10','2030-01-10')$q$, '23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.book('2030-01-11','2030-01-10')$q$, '23514');
SELECT pg_temp.expect_error($q$SELECT pg_temp.book('2030-02-01','2030-02-02','90000000-0000-4000-8000-000000000001')$q$, '23503', 'bookings_room_fk');
SELECT pg_temp.book('2030-01-08','2030-01-10');
SELECT pg_temp.book('2030-01-12','2030-01-14');
SELECT pg_temp.book('2030-01-10','2030-01-12','7c71298a-ef46-457c-ab5e-9edb238a54e5','cancelled');
INSERT INTO rooms(id,name,hotel_id) VALUES ('20000000-0000-4000-8000-000000000001','Second room','80000000-0000-4000-8000-000000000001');
SELECT pg_temp.book('2030-01-10','2030-01-12','20000000-0000-4000-8000-000000000001');
SELECT pg_temp.assert_true((SELECT count(*)=5 FROM bookings), 'only valid bookings persisted');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM bookings WHERE room_id='7c71298a-ef46-457c-ab5e-9edb238a54e5' AND status='confirmed' AND daterange(check_in,check_out,'[)') && daterange('2030-01-10'::date,'2030-01-12'::date,'[)')), 'calendar excludes touching boundaries and cancelled bookings');
SELECT pg_temp.expect_error($q$UPDATE bookings SET guest_phone='0812345678'$q$, '23514', 'guest_phone_valid');
SELECT pg_temp.expect_error($q$UPDATE bookings SET status='cancelled',cancelled_at=NULL$q$, '23514', 'cancellation_consistent');
SELECT pg_temp.expect_error($q$UPDATE bookings SET status='confirmed',cancelled_at=CURRENT_TIMESTAMP$q$, '23514', 'cancellation_consistent');
SELECT pg_temp.expect_error($q$UPDATE bookings SET status='pending'$q$, '22P02');
SELECT pg_temp.expect_error($q$UPDATE bookings SET user_id='90000000-0000-4000-8000-000000000001'$q$, '23503', 'bookings_user_fk');
SELECT pg_temp.expect_error($q$DELETE FROM users WHERE id='10000000-0000-4000-8000-000000000001'$q$, '23503', 'bookings_user_fk');
SELECT pg_temp.expect_error($q$DELETE FROM rooms WHERE id='7c71298a-ef46-457c-ab5e-9edb238a54e5'$q$, '23503', 'bookings_room_fk');
BEGIN;
SELECT pg_temp.book('2030-03-01','2030-03-02');
ROLLBACK;
SELECT pg_temp.assert_true((SELECT count(*)=5 FROM bookings), 'rollback leaves no extra booking');
INSERT INTO users(id,email,password_hash,full_name) VALUES ('30000000-0000-4000-8000-000000000001','cascade@example.com','fixture','Cascade');
INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ('30000000-0000-4000-8000-000000000001',repeat('c',64),CURRENT_TIMESTAMP+INTERVAL '1 day');
DELETE FROM users WHERE id='30000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM sessions WHERE token_hash=repeat('c',64)), 'session cascades on user delete');
BEGIN;
UPDATE bookings SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP
WHERE check_in='2030-01-10' AND room_id='7c71298a-ef46-457c-ab5e-9edb238a54e5';
SELECT pg_temp.book('2030-01-10','2030-01-12');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM bookings WHERE check_in='2030-01-10' AND room_id='7c71298a-ef46-457c-ab5e-9edb238a54e5' AND status='confirmed'), 'cancelled interval can be rebooked');
ROLLBACK;
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','sessions','rooms','bookings') AND is_nullable='YES'), 'only cancelled_at and request_key are nullable');
SELECT pg_temp.assert_true((SELECT is_nullable='YES' FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='cancelled_at'), 'cancelled_at is nullable');
SELECT pg_temp.assert_true((SELECT count(*)=30 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','sessions','rooms','bookings')), 'all 30 columns exist');
SELECT pg_temp.assert_true((SELECT count(*)=4 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','sessions','rooms','bookings') AND column_name='id' AND data_type='uuid' AND column_default LIKE '%gen_random_uuid%'), 'UUID defaults on all primary IDs');
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name IN ('check_in','check_out') AND data_type='date'), 'booking dates use DATE');
SELECT pg_temp.assert_true((SELECT count(*)=9 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','sessions','rooms','bookings') AND data_type='timestamp with time zone'), 'all nine timestamps use TIMESTAMPTZ');
SELECT pg_temp.assert_true((SELECT count(*)=4 FROM pg_indexes WHERE schemaname='public' AND indexname IN ('users_email_lower_uidx','sessions_user_id_idx','sessions_expires_at_idx','bookings_user_created_idx')), 'explicit indexes exist');
SELECT 'PASS database constraints, calendar boundaries, rollback and delete rules';
SELECT pg_temp.expect_error($q$INSERT INTO rate_limit_buckets VALUES('raw-email@example.com',1,CURRENT_TIMESTAMP)$q$,'23514','rate_limit_key_valid');
SELECT pg_temp.expect_error($q$INSERT INTO rate_limit_buckets VALUES(repeat('d',64),0,CURRENT_TIMESTAMP)$q$,'23514','rate_limit_attempts_positive');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM pg_indexes WHERE schemaname='public' AND indexname='rate_limit_expiry_idx'),'rate-limit cleanup index exists');

BEGIN;
INSERT INTO users(id,email,password_hash,full_name) VALUES
('40000000-0000-4000-8000-000000000001','key-a@example.com','fixture','Key A'),
('40000000-0000-4000-8000-000000000002','key-b@example.com','fixture','Key B');
INSERT INTO rooms(id,name,hotel_id) VALUES('40000000-0000-4000-8000-000000000003','Key test','80000000-0000-4000-8000-000000000001');
INSERT INTO bookings(user_id,room_id,check_in,check_out,guest_name,guest_phone,guest_email,request_key) VALUES
('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','2035-01-01','2035-01-02','Guest','+66812345678','guest@example.com','abcdef00-0000-4000-8000-000000000001');
SELECT pg_temp.expect_error($q$INSERT INTO bookings(user_id,room_id,check_in,check_out,guest_name,guest_phone,guest_email,request_key) VALUES('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','2035-01-03','2035-01-04','Guest','+66812345678','guest@example.com','abcdef00-0000-4000-8000-000000000001')$q$,'23505','bookings_user_request_key_unique');
INSERT INTO bookings(user_id,room_id,check_in,check_out,guest_name,guest_phone,guest_email,request_key) VALUES
('40000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000003','2035-01-05','2035-01-06','Guest','+66812345678','guest@example.com','abcdef00-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','2035-01-07','2035-01-08','Guest','+66812345678','guest@example.com',NULL),
('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','2035-01-09','2035-01-10','Guest','+66812345678','guest@example.com',NULL);
SELECT pg_temp.assert_true((SELECT count(*)=4 FROM bookings WHERE room_id='40000000-0000-4000-8000-000000000003'),'idempotency keys are user scoped and allow legacy NULLs');
ROLLBACK;
SELECT 'PASS booking request key uniqueness and legacy compatibility';


SELECT pg_temp.expect_error($q$INSERT INTO rooms(name,hotel_id) VALUES('Orphan','99999999-0000-4000-8000-000000000001')$q$,'23503','rooms_hotel_fk');
SELECT pg_temp.expect_error($q$INSERT INTO hotels(name,province) VALUES('','เชียงใหม่')$q$,'23514','hotels_name_check');
SELECT pg_temp.expect_error($q$INSERT INTO hotels(name,province) VALUES('Test','   ')$q$,'23514','hotels_province_check');
SELECT pg_temp.expect_error($q$DELETE FROM hotels WHERE id='80000000-0000-4000-8000-000000000001'$q$,'23503','rooms_hotel_fk');
SELECT pg_temp.assert_true((SELECT count(DISTINCT province)=8 FROM hotels),'eight provinces seeded');
