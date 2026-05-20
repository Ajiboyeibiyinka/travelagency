-- ============================================================
-- Migration: Option A → Option B
-- Competitive Intelligence System
--
-- Run once:
--   psql -U postgres -d travel_agency -f migrate_option_b.sql
-- ============================================================

BEGIN;

-- ============================================================
-- 1. DROP OLD CHECK CONSTRAINTS FIRST
--    (enum type conversion fails if a CHECK still references old values)
-- ============================================================

ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS inquiries_status_check;
ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS inquiries_source_check;
ALTER TABLE portal_quotes DROP CONSTRAINT IF EXISTS portal_quotes_portal_name_check;


-- ============================================================
-- 2. InquiryStatus — replace enum with Option B values
-- ============================================================

ALTER TABLE inquiries ALTER COLUMN status DROP DEFAULT;
ALTER TABLE inquiries ALTER COLUMN status TYPE TEXT;

-- Map old statuses → new ones (14 test rows)
UPDATE inquiries SET status = CASE status
    WHEN 'new'                THEN 'pending'
    WHEN 'quotes_ready'       THEN 'ranked'
    WHEN 'sent_to_customer'   THEN 'posted'
    WHEN 'customer_confirmed' THEN 'won'
    WHEN 'payment'            THEN 'won'
    WHEN 'booked'             THEN 'won'
    WHEN 'ticket_issued'      THEN 'won'
    ELSE status  -- 'searching', 'cancelled' stay as-is
END;

DROP TYPE "InquiryStatus";
CREATE TYPE "InquiryStatus" AS ENUM (
    'pending', 'searching', 'ranked', 'posted', 'won', 'lost', 'cancelled'
);
ALTER TABLE inquiries
    ALTER COLUMN status TYPE "InquiryStatus"
    USING status::"InquiryStatus";
ALTER TABLE inquiries
    ALTER COLUMN status SET DEFAULT 'pending';


-- ============================================================
-- 3. InquirySource — add supplier_group
-- ============================================================

ALTER TABLE inquiries ALTER COLUMN source DROP DEFAULT;
ALTER TABLE inquiries ALTER COLUMN source TYPE TEXT;

DROP TYPE "InquirySource";
CREATE TYPE "InquirySource" AS ENUM (
    'supplier_group', 'whatsapp', 'phone', 'walk_in'
);
ALTER TABLE inquiries
    ALTER COLUMN source TYPE "InquirySource"
    USING source::"InquirySource";
ALTER TABLE inquiries
    ALTER COLUMN source SET DEFAULT 'supplier_group';


-- ============================================================
-- 4. customer_id — make nullable (group requests have no customer yet)
-- ============================================================

-- Prisma creates named NOT NULL constraints; drop both ways to be safe
ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS inquiries_customer_id_not_null;
ALTER TABLE inquiries ALTER COLUMN customer_id DROP NOT NULL;


-- ============================================================
-- 5. New columns on inquiries
-- ============================================================

ALTER TABLE inquiries
    ADD COLUMN IF NOT EXISTS group_jid           VARCHAR(100),
    ADD COLUMN IF NOT EXISTS requester_jid       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS raw_message         TEXT,
    ADD COLUMN IF NOT EXISTS claimed_by_agent_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS claimed_at          TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_inquiries_group_jid  ON inquiries(group_jid);
CREATE INDEX IF NOT EXISTS idx_inquiries_claimed_by ON inquiries(claimed_by_agent_id);


-- ============================================================
-- 6. PortalName — remove united_nigeria
-- ============================================================

ALTER TABLE portal_quotes ALTER COLUMN portal_name TYPE TEXT;
DROP TYPE "PortalName";
CREATE TYPE "PortalName" AS ENUM ('amadeus', 'airpeace', 'arik', 'ibom');
ALTER TABLE portal_quotes
    ALTER COLUMN portal_name TYPE "PortalName"
    USING portal_name::"PortalName";


-- ============================================================
-- 7. portal_sessions — persistent session health per portal
-- ============================================================

CREATE TABLE IF NOT EXISTS portal_sessions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_name     VARCHAR(50) NOT NULL UNIQUE,
    status          VARCHAR(20) NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('active', 'expired', 'error', 'unknown')),
    last_checked_at TIMESTAMP WITH TIME ZONE,
    requires_reauth BOOLEAN     NOT NULL DEFAULT false,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO portal_sessions (portal_name, status) VALUES
    ('airpeace', 'unknown'),
    ('arik',     'unknown'),
    ('ibom',     'unknown')
ON CONFLICT (portal_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_portal_sessions_status ON portal_sessions(status);


-- ============================================================
-- 8. group_responses — offers posted back to groups
-- ============================================================

CREATE TABLE IF NOT EXISTS group_responses (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id          UUID          NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    portal_quote_id     UUID          REFERENCES portal_quotes(id) ON DELETE SET NULL,
    agent_id            UUID          REFERENCES staff(id) ON DELETE SET NULL,
    group_jid           VARCHAR(100)  NOT NULL,
    base_price          DECIMAL(12,2) NOT NULL,
    markup_type         VARCHAR(10)   NOT NULL CHECK (markup_type IN ('fixed', 'percent')),
    markup_value        DECIMAL(10,2) NOT NULL,
    final_price         DECIMAL(12,2) NOT NULL,
    currency            CHAR(3)       NOT NULL DEFAULT 'NGN',
    response_message    TEXT          NOT NULL,
    whatsapp_message_id VARCHAR(100),
    outcome             VARCHAR(10)   NOT NULL DEFAULT 'unknown'
                            CHECK (outcome IN ('won', 'lost', 'unknown')),
    posted_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_group_responses_inquiry_id ON group_responses(inquiry_id);
CREATE INDEX IF NOT EXISTS idx_group_responses_group_jid  ON group_responses(group_jid);
CREATE INDEX IF NOT EXISTS idx_group_responses_outcome    ON group_responses(outcome);
CREATE INDEX IF NOT EXISTS idx_group_responses_posted_at  ON group_responses(posted_at);


-- ============================================================
-- 9. analytics_daily — win/loss tracking columns
-- ============================================================

ALTER TABLE analytics_daily
    ADD COLUMN IF NOT EXISTS total_offers_posted       INTEGER       DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_won                 INTEGER       DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_lost                INTEGER       DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_response_time_seconds DECIMAL(8, 2);


-- ============================================================
-- 10. Update supplier_groups comments
-- ============================================================

COMMENT ON TABLE supplier_groups IS
    'WhatsApp groups the agency monitors for incoming flight requests. '
    'When a request drops in any active group the system auto-searches portals '
    'and pushes ranked results to the dashboard for agent review.';

COMMENT ON COLUMN supplier_groups.reliability_score IS
    'Win rate score (0-100) based on how often our posted offers succeed in this group.';


COMMIT;
