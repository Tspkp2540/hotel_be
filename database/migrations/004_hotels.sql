CREATE TABLE hotels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL CHECK (length(btrim(name)) > 0),
    province VARCHAR(100) NOT NULL CHECK (length(btrim(province)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Preserve existing rooms and bookings under one property when upgrading.
INSERT INTO hotels(id,name,province) VALUES
('80000000-0000-4000-8000-000000000001','บ้านพักเชียงใหม่','เชียงใหม่');
ALTER TABLE rooms ADD COLUMN hotel_id UUID;
UPDATE rooms SET hotel_id='80000000-0000-4000-8000-000000000001';
ALTER TABLE rooms ALTER COLUMN hotel_id SET NOT NULL;
ALTER TABLE rooms ADD CONSTRAINT rooms_hotel_fk FOREIGN KEY(hotel_id) REFERENCES hotels(id) ON DELETE RESTRICT;
CREATE INDEX rooms_hotel_idx ON rooms(hotel_id);
