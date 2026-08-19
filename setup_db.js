const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const sql = `
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    bvn VARCHAR(11) UNIQUE,
    id_type VARCHAR(50),
    id_number VARCHAR(50),
    kyc_status VARCHAR(20) DEFAULT 'pending',
    role VARCHAR(20) DEFAULT 'buyer',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS properties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    address TEXT NOT NULL,
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(50) DEFAULT 'Nigeria',
    property_type VARCHAR(50),
    price_ngn DECIMAL(15,2) NOT NULL,
    price_usd DECIMAL(15,2) NOT NULL,
    currency_display VARCHAR(3) DEFAULT 'NGN',
    ownership_type VARCHAR(20) NOT NULL DEFAULT 'third_party',
    seller_id UUID REFERENCES users(id) ON DELETE SET NULL,
    engineering_score INT CHECK (engineering_score >= 0 AND engineering_score <= 100),
    inspection_status VARCHAR(20) DEFAULT 'pending',
    inspection_report_url TEXT,
    is_certified BOOLEAN DEFAULT FALSE,
    year_built INT,
    land_size_sqm DECIMAL(10,2),
    bedrooms INT,
    bathrooms INT,
    images TEXT[],
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
    buyer_id UUID REFERENCES users(id),
    seller_id UUID REFERENCES users(id),
    amount_ngn DECIMAL(15,2),
    amount_usd DECIMAL(15,2),
    currency_used VARCHAR(3) NOT NULL,
    payment_method VARCHAR(50),
    payment_reference VARCHAR(100) UNIQUE,
    escrow_status VARCHAR(20) DEFAULT 'held',
    inspection_released BOOLEAN DEFAULT FALSE,
    commission_rate DECIMAL(5,2) DEFAULT 0.03,
    commission_amount_ngn DECIMAL(15,2),
    commission_amount_usd DECIMAL(15,2),
    created_at TIMESTAMP DEFAULT NOW(),
    released_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inspections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
    engineer_id UUID REFERENCES users(id),
    inspection_date DATE NOT NULL,
    score INT CHECK (score >= 0 AND score <= 100),
    status VARCHAR(20) DEFAULT 'pending',
    checklist JSONB,
    notes TEXT,
    report_url TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maintenance_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
    owner_id UUID REFERENCES users(id),
    plan_type VARCHAR(50),
    price_ngn DECIMAL(15,2),
    price_usd DECIMAL(15,2),
    billing_cycle VARCHAR(20),
    start_date DATE,
    end_date DATE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);
`;

async function setup() {
    try {
        await pool.query(sql);
        console.log('✅ Tables created successfully on Render Cloud Database!');
    } catch (err) {
        console.error('❌ Error creating tables:', err);
    }
    process.exit();
}

setup();