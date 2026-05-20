-- ============================================================
-- PostgreSQL Database Schema for Travel Agency WhatsApp Automation System
-- Complete schema with tables, indexes, triggers, and seed data
-- ============================================================

-- ============================================================
-- 1. TABLE DEFINITIONS
-- ============================================================

-- Staff Table
CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(50) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'agent')),
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE
);

-- Customers Table
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255),
    email VARCHAR(255),
    total_inquiries INTEGER DEFAULT 0,
    total_bookings INTEGER DEFAULT 0,
    total_spent DECIMAL(12, 2) DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Inquiries Table
CREATE TABLE inquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    assigned_agent_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    origin_city VARCHAR(100) NOT NULL,
    origin_code CHAR(3) NOT NULL,
    destination_city VARCHAR(100) NOT NULL,
    destination_code CHAR(3) NOT NULL,
    departure_date DATE NOT NULL,
    return_date DATE,
    passengers_adult INTEGER DEFAULT 1,
    passengers_child INTEGER DEFAULT 0,
    passengers_infant INTEGER DEFAULT 0,
    travel_class VARCHAR(20) NOT NULL CHECK (travel_class IN ('economy', 'business', 'first')),
    trip_type VARCHAR(20) NOT NULL CHECK (trip_type IN ('one_way', 'round_trip')),
    budget_max DECIMAL(12, 2),
    special_requests TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'new' CHECK (status IN (
        'new', 'searching', 'quotes_ready', 'sent_to_customer',
        'customer_confirmed', 'payment', 'booked', 'ticket_issued', 'cancelled'
    )),
    source VARCHAR(20) NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'phone', 'walk_in')),
    -- Stores the AI-ranked quote order from quote-compiler so booking-handler can resolve "Option 1" correctly.
    -- Format: [{ "rank": 1, "quote_id": "uuid", "source": "whatsapp_group|airline_portal", "reason": "..." }]
    -- Migration for existing DBs: ALTER TABLE inquiries ADD COLUMN ranked_quote_ids JSONB;
    ranked_quote_ids JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Supplier Quotes Table
CREATE TABLE supplier_quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    supplier_group_name VARCHAR(100) NOT NULL,
    supplier_name VARCHAR(100) NOT NULL,
    airline VARCHAR(100),
    flight_number VARCHAR(20),
    departure_time TIMESTAMP WITH TIME ZONE,
    arrival_time TIMESTAMP WITH TIME ZONE,
    price_amount DECIMAL(12, 2) NOT NULL,
    price_currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (price_currency IN ('NGN', 'USD')),
    class VARCHAR(20),
    stops INTEGER DEFAULT 0 CHECK (stops >= 0),
    raw_message TEXT NOT NULL,
    ai_confidence_score INTEGER CHECK (ai_confidence_score >= 0 AND ai_confidence_score <= 100),
    is_selected BOOLEAN DEFAULT false,
    source VARCHAR(30) NOT NULL DEFAULT 'whatsapp_group' CHECK (source IN ('whatsapp_group', 'amadeus', 'local_portal')),
    portal_name VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Portal Quotes Table (for Amadeus and local airline results)
CREATE TABLE portal_quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    portal_name VARCHAR(50) NOT NULL CHECK (portal_name IN ('amadeus', 'airpeace', 'arik', 'united_nigeria', 'ibom')),
    airline VARCHAR(100) NOT NULL,
    flight_number VARCHAR(20) NOT NULL,
    departure_time TIMESTAMP WITH TIME ZONE NOT NULL,
    arrival_time TIMESTAMP WITH TIME ZONE NOT NULL,
    price_amount DECIMAL(12, 2) NOT NULL,
    price_currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (price_currency IN ('NGN', 'USD')),
    class VARCHAR(20) NOT NULL,
    stops INTEGER DEFAULT 0 CHECK (stops >= 0),
    baggage_allowance VARCHAR(50),
    booking_code VARCHAR(50),
    raw_response JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Bookings Table
CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inquiry_id UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    selected_quote_id UUID REFERENCES supplier_quotes(id) ON DELETE SET NULL,
    selected_portal_quote_id UUID REFERENCES portal_quotes(id) ON DELETE SET NULL,
    total_amount DECIMAL(12, 2) NOT NULL,
    payment_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'partial', 'paid')),
    payment_method VARCHAR(50),
    payment_reference VARCHAR(100),
    booking_reference VARCHAR(50),
    passenger_details JSONB NOT NULL,
    ticket_issued BOOLEAN DEFAULT false,
    ticket_file_url VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'ticketed', 'cancelled', 'refunded')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Passengers Table
CREATE TABLE passengers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    title VARCHAR(10) NOT NULL CHECK (title IN ('Mr', 'Mrs', 'Miss')),
    date_of_birth DATE NOT NULL,
    nationality VARCHAR(100) NOT NULL,
    passport_number VARCHAR(50),
    passport_expiry DATE,
    phone VARCHAR(50),
    email VARCHAR(255),
    passenger_type VARCHAR(10) NOT NULL CHECK (passenger_type IN ('adult', 'child', 'infant'))
);

-- Conversations Table
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    inquiry_id UUID REFERENCES inquiries(id) ON DELETE SET NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_text TEXT NOT NULL,
    message_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'document', 'voice')),
    whatsapp_message_id VARCHAR(100),
    channel VARCHAR(20) NOT NULL DEFAULT 'customer_bot' CHECK (channel IN ('customer_bot', 'supplier_group')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Supplier Groups Table
CREATE TABLE supplier_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_name VARCHAR(100) NOT NULL,
    group_whatsapp_id VARCHAR(100) NOT NULL UNIQUE,
    speciality VARCHAR(20) NOT NULL DEFAULT 'all' CHECK (speciality IN ('domestic', 'international', 'charter', 'all')),
    reliability_score INTEGER DEFAULT 50 CHECK (reliability_score >= 0 AND reliability_score <= 100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Portal Search Logs Table (for debugging portal scraping issues)
CREATE TABLE portal_search_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_name VARCHAR(50) NOT NULL,
    event_type VARCHAR(30) NOT NULL CHECK (event_type IN (
        'search_success', 'search_error', 'search_timeout',
        'session_expired', 'search_skipped', 'session_ok'
    )),
    message TEXT,
    inquiry_id UUID REFERENCES inquiries(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_portal_search_logs_portal ON portal_search_logs(portal_name);
CREATE INDEX idx_portal_search_logs_event ON portal_search_logs(event_type);
CREATE INDEX idx_portal_search_logs_created ON portal_search_logs(created_at);

-- Analytics Daily Table
CREATE TABLE analytics_daily (
    id SERIAL PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    total_inquiries INTEGER DEFAULT 0,
    total_quotes_received INTEGER DEFAULT 0,
    total_bookings INTEGER DEFAULT 0,
    total_revenue DECIMAL(12, 2) DEFAULT 0.00,
    avg_response_time_minutes DECIMAL(6, 2),
    most_popular_route VARCHAR(100),
    busiest_hour INTEGER CHECK (busiest_hour >= 0 AND busiest_hour <= 23)
);


-- ============================================================
-- 2. INDEXES
-- ============================================================

-- Staff indexes
CREATE INDEX idx_staff_email ON staff(email);
CREATE INDEX idx_staff_role ON staff(role);
CREATE INDEX idx_staff_is_active ON staff(is_active);
CREATE INDEX idx_staff_created_at ON staff(created_at);

-- Customers indexes
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_created_at ON customers(created_at);
CREATE INDEX idx_customers_updated_at ON customers(updated_at);

-- Inquiries indexes
CREATE INDEX idx_inquiries_customer_id ON inquiries(customer_id);
CREATE INDEX idx_inquiries_assigned_agent_id ON inquiries(assigned_agent_id);
CREATE INDEX idx_inquiries_status ON inquiries(status);
CREATE INDEX idx_inquiries_departure_date ON inquiries(departure_date);
CREATE INDEX idx_inquiries_created_at ON inquiries(created_at);
CREATE INDEX idx_inquiries_updated_at ON inquiries(updated_at);
CREATE INDEX idx_inquiries_origin_destination ON inquiries(origin_code, destination_code);

-- Supplier Quotes indexes
CREATE INDEX idx_supplier_quotes_inquiry_id ON supplier_quotes(inquiry_id);
CREATE INDEX idx_supplier_quotes_is_selected ON supplier_quotes(is_selected);
CREATE INDEX idx_supplier_quotes_price_amount ON supplier_quotes(price_amount);
CREATE INDEX idx_supplier_quotes_created_at ON supplier_quotes(created_at);
CREATE INDEX idx_supplier_quotes_ai_confidence ON supplier_quotes(ai_confidence_score);
CREATE INDEX idx_supplier_quotes_source ON supplier_quotes(source);

-- Portal Quotes indexes
CREATE INDEX idx_portal_quotes_inquiry_id ON portal_quotes(inquiry_id);
CREATE INDEX idx_portal_quotes_portal_name ON portal_quotes(portal_name);
CREATE INDEX idx_portal_quotes_price_amount ON portal_quotes(price_amount);
CREATE INDEX idx_portal_quotes_created_at ON portal_quotes(created_at);
CREATE INDEX idx_portal_quotes_airline ON portal_quotes(airline);
CREATE INDEX idx_portal_quotes_departure_time ON portal_quotes(departure_time);

-- Bookings indexes
CREATE INDEX idx_bookings_inquiry_id ON bookings(inquiry_id);
CREATE INDEX idx_bookings_customer_id ON bookings(customer_id);
CREATE INDEX idx_bookings_payment_status ON bookings(payment_status);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_booking_reference ON bookings(booking_reference);
CREATE INDEX idx_bookings_created_at ON bookings(created_at);
CREATE INDEX idx_bookings_updated_at ON bookings(updated_at);
CREATE INDEX idx_bookings_ticket_issued ON bookings(ticket_issued);

-- Passengers indexes
CREATE INDEX idx_passengers_booking_id ON passengers(booking_id);
CREATE INDEX idx_passengers_passport_number ON passengers(passport_number);
CREATE INDEX idx_passengers_full_name ON passengers(full_name);
CREATE INDEX idx_passengers_passenger_type ON passengers(passenger_type);

-- Conversations indexes
CREATE INDEX idx_conversations_customer_id ON conversations(customer_id);
CREATE INDEX idx_conversations_inquiry_id ON conversations(inquiry_id);
CREATE INDEX idx_conversations_direction ON conversations(direction);
CREATE INDEX idx_conversations_created_at ON conversations(created_at);
CREATE INDEX idx_conversations_channel ON conversations(channel);
CREATE INDEX idx_conversations_whatsapp_message_id ON conversations(whatsapp_message_id);

-- Supplier Groups indexes
CREATE INDEX idx_supplier_groups_group_whatsapp_id ON supplier_groups(group_whatsapp_id);
CREATE INDEX idx_supplier_groups_speciality ON supplier_groups(speciality);
CREATE INDEX idx_supplier_groups_reliability_score ON supplier_groups(reliability_score);
CREATE INDEX idx_supplier_groups_is_active ON supplier_groups(is_active);
CREATE INDEX idx_supplier_groups_created_at ON supplier_groups(created_at);

-- Analytics Daily indexes
CREATE INDEX idx_analytics_daily_date ON analytics_daily(date);
CREATE INDEX idx_analytics_daily_total_revenue ON analytics_daily(total_revenue);
CREATE INDEX idx_analytics_daily_total_bookings ON analytics_daily(total_bookings);


-- ============================================================
-- 3. TRIGGERS & FUNCTIONS
-- ============================================================

-- 1. Auto-increment customers.total_inquiries on new inquiry
CREATE OR REPLACE FUNCTION update_customer_inquiry_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE customers 
    SET total_inquiries = total_inquiries + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.customer_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_customer_inquiry_count
AFTER INSERT ON inquiries
FOR EACH ROW
EXECUTE FUNCTION update_customer_inquiry_count();

-- 2. Auto-increment customers.total_bookings & total_spent on new booking
CREATE OR REPLACE FUNCTION update_customer_booking_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE customers 
    SET total_bookings = total_bookings + 1,
        total_spent = total_spent + NEW.total_amount,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.customer_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_customer_booking_count
AFTER INSERT ON bookings
FOR EACH ROW
EXECUTE FUNCTION update_customer_booking_count();

-- 3. Update analytics_daily when a booking is completed (status → 'ticketed')
CREATE OR REPLACE FUNCTION update_analytics_on_booking_completion()
RETURNS TRIGGER AS $$
DECLARE
    booking_date DATE;
BEGIN
    IF NEW.status = 'ticketed' AND (OLD.status IS NULL OR OLD.status != 'ticketed') THEN
        booking_date := DATE(NEW.created_at);
        
        INSERT INTO analytics_daily (date, total_bookings, total_revenue)
        VALUES (booking_date, 1, NEW.total_amount)
        ON CONFLICT (date) 
        DO UPDATE SET 
            total_bookings = analytics_daily.total_bookings + 1,
            total_revenue = analytics_daily.total_revenue + NEW.total_amount;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_analytics_on_booking_completion
AFTER UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION update_analytics_on_booking_completion();

-- 4. Update analytics_daily when a new inquiry is created
CREATE OR REPLACE FUNCTION update_analytics_on_inquiry_creation()
RETURNS TRIGGER AS $$
DECLARE
    inquiry_date DATE;
BEGIN
    inquiry_date := DATE(NEW.created_at);
    
    INSERT INTO analytics_daily (date, total_inquiries)
    VALUES (inquiry_date, 1)
    ON CONFLICT (date) 
    DO UPDATE SET 
        total_inquiries = analytics_daily.total_inquiries + 1;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_analytics_on_inquiry_creation
AFTER INSERT ON inquiries
FOR EACH ROW
EXECUTE FUNCTION update_analytics_on_inquiry_creation();

-- 5. Update analytics_daily when a new quote is received
CREATE OR REPLACE FUNCTION update_analytics_on_quote_received()
RETURNS TRIGGER AS $$
DECLARE
    quote_date DATE;
BEGIN
    quote_date := DATE(NEW.created_at);
    
    INSERT INTO analytics_daily (date, total_quotes_received)
    VALUES (quote_date, 1)
    ON CONFLICT (date) 
    DO UPDATE SET 
        total_quotes_received = analytics_daily.total_quotes_received + 1;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply quote trigger to both supplier_quotes and portal_quotes
CREATE TRIGGER trigger_update_analytics_on_supplier_quote
AFTER INSERT ON supplier_quotes
FOR EACH ROW
EXECUTE FUNCTION update_analytics_on_quote_received();

CREATE TRIGGER trigger_update_analytics_on_portal_quote
AFTER INSERT ON portal_quotes
FOR EACH ROW
EXECUTE FUNCTION update_analytics_on_quote_received();


-- ============================================================
-- 4. TABLE & COLUMN COMMENTS
-- ============================================================

-- Staff comments
COMMENT ON TABLE staff IS 'Stores staff information for the travel agency WhatsApp automation system';
COMMENT ON COLUMN staff.id IS 'Unique identifier for staff member (UUID)';
COMMENT ON COLUMN staff.name IS 'Full name of staff member';
COMMENT ON COLUMN staff.email IS 'Email address (must be unique)';
COMMENT ON COLUMN staff.phone IS 'Phone number for contact';
COMMENT ON COLUMN staff.role IS 'Role: admin or agent';
COMMENT ON COLUMN staff.password_hash IS 'Hashed password for authentication';
COMMENT ON COLUMN staff.is_active IS 'Indicates if staff account is active';
COMMENT ON COLUMN staff.created_at IS 'Timestamp when staff account was created';
COMMENT ON COLUMN staff.last_login IS 'Timestamp of last successful login';

-- Customers comments
COMMENT ON TABLE customers IS 'Stores customer information for the travel agency WhatsApp automation system';
COMMENT ON COLUMN customers.id IS 'Unique identifier for customer (UUID)';
COMMENT ON COLUMN customers.phone IS 'Phone number (must be unique, used for WhatsApp communication)';
COMMENT ON COLUMN customers.name IS 'Customer name';
COMMENT ON COLUMN customers.email IS 'Customer email address';
COMMENT ON COLUMN customers.total_inquiries IS 'Total number of flight inquiries made by customer';
COMMENT ON COLUMN customers.total_bookings IS 'Total number of successful bookings made by customer';
COMMENT ON COLUMN customers.total_spent IS 'Total amount spent by customer across all bookings';
COMMENT ON COLUMN customers.created_at IS 'Timestamp when customer record was created';
COMMENT ON COLUMN customers.updated_at IS 'Timestamp when customer record was last updated';

-- Inquiries comments
COMMENT ON TABLE inquiries IS 'Stores flight inquiry details from customers';
COMMENT ON COLUMN inquiries.id IS 'Unique identifier for inquiry (UUID)';
COMMENT ON COLUMN inquiries.customer_id IS 'Foreign key to customers table';
COMMENT ON COLUMN inquiries.assigned_agent_id IS 'Foreign key to staff table (agent assigned to handle inquiry)';
COMMENT ON COLUMN inquiries.origin_city IS 'Origin city name';
COMMENT ON COLUMN inquiries.origin_code IS 'Origin airport IATA 3-letter code';
COMMENT ON COLUMN inquiries.destination_city IS 'Destination city name';
COMMENT ON COLUMN inquiries.destination_code IS 'Destination airport IATA 3-letter code';
COMMENT ON COLUMN inquiries.departure_date IS 'Departure date';
COMMENT ON COLUMN inquiries.return_date IS 'Return date (null for one-way trips)';
COMMENT ON COLUMN inquiries.passengers_adult IS 'Number of adult passengers';
COMMENT ON COLUMN inquiries.passengers_child IS 'Number of child passengers';
COMMENT ON COLUMN inquiries.passengers_infant IS 'Number of infant passengers';
COMMENT ON COLUMN inquiries.travel_class IS 'Travel class: economy, business, or first';
COMMENT ON COLUMN inquiries.trip_type IS 'Trip type: one_way or round_trip';
COMMENT ON COLUMN inquiries.budget_max IS 'Maximum budget for the trip';
COMMENT ON COLUMN inquiries.special_requests IS 'Special requests or notes from customer';
COMMENT ON COLUMN inquiries.status IS 'Current status of inquiry workflow';
COMMENT ON COLUMN inquiries.source IS 'Source of inquiry: whatsapp, phone, or walk_in';
COMMENT ON COLUMN inquiries.created_at IS 'Timestamp when inquiry was created';
COMMENT ON COLUMN inquiries.updated_at IS 'Timestamp when inquiry was last updated';

-- Supplier Quotes comments
COMMENT ON TABLE supplier_quotes IS 'Stores quotes received from suppliers for flight inquiries';
COMMENT ON COLUMN supplier_quotes.id IS 'Unique identifier for supplier quote (UUID)';
COMMENT ON COLUMN supplier_quotes.inquiry_id IS 'Foreign key to inquiries table';
COMMENT ON COLUMN supplier_quotes.supplier_group_name IS 'Name of WhatsApp group where quote was received';
COMMENT ON COLUMN supplier_quotes.supplier_name IS 'Name of supplier extracted from message';
COMMENT ON COLUMN supplier_quotes.airline IS 'Airline name';
COMMENT ON COLUMN supplier_quotes.flight_number IS 'Flight number';
COMMENT ON COLUMN supplier_quotes.departure_time IS 'Departure date and time';
COMMENT ON COLUMN supplier_quotes.arrival_time IS 'Arrival date and time';
COMMENT ON COLUMN supplier_quotes.price_amount IS 'Price amount';
COMMENT ON COLUMN supplier_quotes.price_currency IS 'Currency: NGN or USD';
COMMENT ON COLUMN supplier_quotes.class IS 'Travel class';
COMMENT ON COLUMN supplier_quotes.stops IS 'Number of stops (0=direct, 1=1 stop, etc.)';
COMMENT ON COLUMN supplier_quotes.raw_message IS 'Original WhatsApp text message';
COMMENT ON COLUMN supplier_quotes.ai_confidence_score IS 'AI confidence score for extraction (0-100)';
COMMENT ON COLUMN supplier_quotes.is_selected IS 'Indicates if this quote was selected by customer';
COMMENT ON COLUMN supplier_quotes.source IS 'Source of quote: whatsapp_group, amadeus, or local_portal';
COMMENT ON COLUMN supplier_quotes.portal_name IS 'Name of portal if source is local_portal (e.g., "Air Peace Portal")';
COMMENT ON COLUMN supplier_quotes.created_at IS 'Timestamp when quote was received/created';

-- Portal Quotes comments
COMMENT ON TABLE portal_quotes IS 'Stores quotes from Amadeus and local airline portals';
COMMENT ON COLUMN portal_quotes.id IS 'Unique identifier for portal quote (UUID)';
COMMENT ON COLUMN portal_quotes.inquiry_id IS 'Foreign key to inquiries table';
COMMENT ON COLUMN portal_quotes.portal_name IS 'Portal name: amadeus, airpeace, arik, united_nigeria, or ibom';
COMMENT ON COLUMN portal_quotes.airline IS 'Airline name';
COMMENT ON COLUMN portal_quotes.flight_number IS 'Flight number';
COMMENT ON COLUMN portal_quotes.departure_time IS 'Departure date and time';
COMMENT ON COLUMN portal_quotes.arrival_time IS 'Arrival date and time';
COMMENT ON COLUMN portal_quotes.price_amount IS 'Price amount';
COMMENT ON COLUMN portal_quotes.price_currency IS 'Currency: NGN or USD';
COMMENT ON COLUMN portal_quotes.class IS 'Travel class';
COMMENT ON COLUMN portal_quotes.stops IS 'Number of stops (0=direct, 1=1 stop, etc.)';
COMMENT ON COLUMN portal_quotes.baggage_allowance IS 'Baggage allowance information';
COMMENT ON COLUMN portal_quotes.booking_code IS 'GDS PNR or booking reference code';
COMMENT ON COLUMN portal_quotes.raw_response IS 'JSON of full portal response';
COMMENT ON COLUMN portal_quotes.created_at IS 'Timestamp when quote was retrieved from portal';

-- Bookings comments
COMMENT ON TABLE bookings IS 'Stores finalized bookings and payment information';
COMMENT ON COLUMN bookings.id IS 'Unique identifier for booking (UUID)';
COMMENT ON COLUMN bookings.inquiry_id IS 'Foreign key to inquiries table';
COMMENT ON COLUMN bookings.customer_id IS 'Foreign key to customers table';
COMMENT ON COLUMN bookings.selected_quote_id IS 'Foreign key to supplier_quotes table (quote selected from WhatsApp groups)';
COMMENT ON COLUMN bookings.selected_portal_quote_id IS 'Foreign key to portal_quotes table (quote selected from portals)';
COMMENT ON COLUMN bookings.total_amount IS 'Total booking amount';
COMMENT ON COLUMN bookings.payment_status IS 'Payment status: pending, partial, or paid';
COMMENT ON COLUMN bookings.payment_method IS 'Payment method used';
COMMENT ON COLUMN bookings.payment_reference IS 'Payment reference or transaction ID';
COMMENT ON COLUMN bookings.booking_reference IS 'PNR or ticket number from airline';
COMMENT ON COLUMN bookings.passenger_details IS 'JSONB array of passenger objects with details';
COMMENT ON COLUMN bookings.ticket_issued IS 'Indicates if ticket has been issued';
COMMENT ON COLUMN bookings.ticket_file_url IS 'URL to ticket file if available';
COMMENT ON COLUMN bookings.status IS 'Booking status: confirmed, ticketed, cancelled, or refunded';
COMMENT ON COLUMN bookings.created_at IS 'Timestamp when booking was created';
COMMENT ON COLUMN bookings.updated_at IS 'Timestamp when booking was last updated';

-- Passengers comments
COMMENT ON TABLE passengers IS 'Stores detailed passenger information for bookings';
COMMENT ON COLUMN passengers.id IS 'Unique identifier for passenger (UUID)';
COMMENT ON COLUMN passengers.booking_id IS 'Foreign key to bookings table';
COMMENT ON COLUMN passengers.full_name IS 'Full name of passenger';
COMMENT ON COLUMN passengers.title IS 'Title: Mr, Mrs, or Miss';
COMMENT ON COLUMN passengers.date_of_birth IS 'Date of birth';
COMMENT ON COLUMN passengers.nationality IS 'Nationality';
COMMENT ON COLUMN passengers.passport_number IS 'Passport number (for international flights)';
COMMENT ON COLUMN passengers.passport_expiry IS 'Passport expiry date';
COMMENT ON COLUMN passengers.phone IS 'Phone number';
COMMENT ON COLUMN passengers.email IS 'Email address';
COMMENT ON COLUMN passengers.passenger_type IS 'Passenger type: adult, child, or infant';

-- Conversations comments
COMMENT ON TABLE conversations IS 'Stores WhatsApp conversation history';
COMMENT ON COLUMN conversations.id IS 'Unique identifier for conversation message (UUID)';
COMMENT ON COLUMN conversations.customer_id IS 'Foreign key to customers table';
COMMENT ON COLUMN conversations.inquiry_id IS 'Foreign key to inquiries table (nullable if message is not related to specific inquiry)';
COMMENT ON COLUMN conversations.direction IS 'Message direction: inbound or outbound';
COMMENT ON COLUMN conversations.message_text IS 'Message text content';
COMMENT ON COLUMN conversations.message_type IS 'Message type: text, image, document, or voice';
COMMENT ON COLUMN conversations.whatsapp_message_id IS 'Original WhatsApp message ID for reference';
COMMENT ON COLUMN conversations.channel IS 'Channel: customer_bot or supplier_group';
COMMENT ON COLUMN conversations.created_at IS 'Timestamp when message was sent/received';

-- Supplier Groups comments
COMMENT ON TABLE supplier_groups IS 'Stores information about WhatsApp supplier groups';
COMMENT ON COLUMN supplier_groups.id IS 'Unique identifier for supplier group (UUID)';
COMMENT ON COLUMN supplier_groups.group_name IS 'Name of the WhatsApp group';
COMMENT ON COLUMN supplier_groups.group_whatsapp_id IS 'WhatsApp group ID (must be unique)';
COMMENT ON COLUMN supplier_groups.speciality IS 'Group speciality: domestic, international, charter, or all';
COMMENT ON COLUMN supplier_groups.reliability_score IS 'Reliability score (0-100) based on historical performance';
COMMENT ON COLUMN supplier_groups.is_active IS 'Indicates if group is currently active';
COMMENT ON COLUMN supplier_groups.created_at IS 'Timestamp when group was added to system';

-- Analytics Daily comments
COMMENT ON TABLE analytics_daily IS 'Stores daily analytics and performance metrics';
COMMENT ON COLUMN analytics_daily.id IS 'Auto-incrementing primary key';
COMMENT ON COLUMN analytics_daily.date IS 'Date for the analytics (must be unique)';
COMMENT ON COLUMN analytics_daily.total_inquiries IS 'Total number of inquiries received on this date';
COMMENT ON COLUMN analytics_daily.total_quotes_received IS 'Total number of quotes received from suppliers on this date';
COMMENT ON COLUMN analytics_daily.total_bookings IS 'Total number of bookings made on this date';
COMMENT ON COLUMN analytics_daily.total_revenue IS 'Total revenue generated on this date';
COMMENT ON COLUMN analytics_daily.avg_response_time_minutes IS 'Average response time to customer inquiries in minutes';
COMMENT ON COLUMN analytics_daily.most_popular_route IS 'Most frequently requested route on this date';
COMMENT ON COLUMN analytics_daily.busiest_hour IS 'Busiest hour of the day (0-23) based on inquiry volume';


-- ============================================================
-- 5. SEED DATA — 3 Sample Supplier Groups
-- ============================================================

INSERT INTO supplier_groups (id, group_name, group_whatsapp_id, speciality, reliability_score, is_active, created_at)
VALUES
    -- 1. Domestic flights specialist – high reliability, very active
    (
        'a1b2c3d4-e5f6-7890-abcd-ef1234567801',
        'Naija Domestic Flights Deals',
        '120363001234567890@g.us',
        'domestic',
        85,
        true,
        '2025-06-15 09:30:00+01'
    ),
    -- 2. International flights group – moderate reliability, active
    (
        'a1b2c3d4-e5f6-7890-abcd-ef1234567802',
        'Global Wings International Fares',
        '120363009876543210@g.us',
        'international',
        72,
        true,
        '2025-08-22 14:00:00+01'
    ),
    -- 3. Charter & VIP travel – newer group, still building track record
    (
        'a1b2c3d4-e5f6-7890-abcd-ef1234567803',
        'Premium Charter & VIP Flights',
        '120363005555666677@g.us',
        'charter',
        60,
        true,
        '2026-01-10 11:45:00+01'
    );