-- When and how a replacement owed after a case was fulfilled (for the use-to-replace cadence).
ALTER TABLE replenishments ADD COLUMN done_at timestamptz;
ALTER TABLE replenishments ADD COLUMN done_by uuid REFERENCES users(id);
ALTER TABLE replenishments ADD COLUMN order_ref text;
