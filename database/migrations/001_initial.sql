CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE booking_status AS ENUM ('confirmed', 'cancelled');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(254) NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_name_nonempty CHECK (length(btrim(full_name)) > 0)
);

CREATE UNIQUE INDEX users_email_lower_uidx ON users (lower(email));

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT sessions_user_fk FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT session_expiry_valid CHECK (expires_at > created_at),
    CONSTRAINT session_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT rooms_name_nonempty CHECK (length(btrim(name)) > 0)
);

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    room_id UUID NOT NULL,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    guest_name VARCHAR(150) NOT NULL,
    guest_phone VARCHAR(16) NOT NULL,
    guest_email VARCHAR(254) NOT NULL,
    status booking_status NOT NULL DEFAULT 'confirmed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_at TIMESTAMPTZ NULL DEFAULT NULL,
    CONSTRAINT bookings_user_fk FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT bookings_room_fk FOREIGN KEY (room_id)
        REFERENCES rooms(id) ON DELETE RESTRICT,
    CONSTRAINT valid_booking_dates CHECK (check_out > check_in),
    CONSTRAINT guest_name_nonempty CHECK (length(btrim(guest_name)) > 0),
    CONSTRAINT guest_phone_valid CHECK (guest_phone ~ '^\+[1-9][0-9]{1,14}$'),
    CONSTRAINT cancellation_consistent CHECK (
        (status = 'confirmed' AND cancelled_at IS NULL)
        OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
    ),
    CONSTRAINT prevent_overlapping_bookings EXCLUDE USING gist (
        room_id WITH =,
        daterange(check_in, check_out, '[)') WITH &&
    ) WHERE (status = 'confirmed')
);

CREATE INDEX bookings_user_created_idx
    ON bookings (user_id, created_at DESC, id DESC);
