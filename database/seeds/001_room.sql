INSERT INTO rooms (id, name, is_active)
VALUES
    ('7c71298a-ef46-457c-ab5e-9edb238a54e5', 'บ้านพักหลัก', TRUE),
    ('7c71298a-ef46-457c-ab5e-9edb238a54e6', 'ห้องสวน', TRUE),
    ('7c71298a-ef46-457c-ab5e-9edb238a54e7', 'ห้องระเบียง', TRUE),
    ('7c71298a-ef46-457c-ab5e-9edb238a54e8', 'ห้องแสงเช้า', TRUE),
    ('7c71298a-ef46-457c-ab5e-9edb238a54e9', 'ห้องมุมสงบ', TRUE)
ON CONFLICT (id) DO NOTHING;
