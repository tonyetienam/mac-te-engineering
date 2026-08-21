const { Pool } = require('pg');
require('dotenv').config();

// Database connection with SSL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const sql = `
DROP TABLE IF EXISTS cart_items CASCADE;
DROP TABLE IF EXISTS cart CASCADE;
DROP TABLE IF EXISTS products CASCADE;

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id UUID,
    category_id UUID,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price_ngn DECIMAL(15,2) NOT NULL,
    stock_quantity INT DEFAULT 0,
    main_image TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID REFERENCES cart(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    quantity INT DEFAULT 1
);
`;

async function setup() {
    try {
        await pool.query(sql);
        console.log('✅ Database reset and tables created successfully!');
    } catch (err) {
        console.error('❌ Error creating tables:', err);
    }
    process.exit();
}

setup();