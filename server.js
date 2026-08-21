require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Database connection (Cloud Render)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test database connection
pool.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
    } else {
        console.log('✅ Connected to PostgreSQL database');
    }
});

// AUTO-CREATE CART TABLES ON SERVER STARTUP
const createCartTables = async () => {
    try {
        await pool.query(`
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
        `);
        console.log('✅ Cart tables ensured in database');
    } catch (err) {
        console.error('Error creating cart tables:', err);
    }
};
createCartTables();

// AUTO-CREATE/UPDATE USERS TABLE ON SERVER STARTUP
const createUsersTable = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                full_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                phone VARCHAR(20),
                role VARCHAR(20) DEFAULT 'customer',
                reset_otp VARCHAR(10),
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        
        const columnCheck = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'reset_otp'
        `);
        
        if (columnCheck.rows.length === 0) {
            await pool.query(`ALTER TABLE users ADD COLUMN reset_otp VARCHAR(10)`);
            console.log('✅ Added reset_otp column to users table');
        } else {
            console.log('✅ reset_otp column already exists');
        }
        
        const passwordCheck = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'password_hash'
        `);
        
        if (passwordCheck.rows.length === 0) {
            await pool.query(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NOT NULL DEFAULT 'temp_password'`);
            console.log('✅ Added password_hash column to users table');
        } else {
            console.log('✅ password_hash column already exists');
        }
        
    } catch (err) {
        console.error('Error creating/updating users table:', err);
    }
};
createUsersTable();

// ------------ AUTHENTICATION ROUTES ------------
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-123';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'your-google-client-id.apps.googleusercontent.com';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// 1. REGISTER (POST)
app.post('/api/auth/register', async (req, res) => {
    const { full_name, email, phone, password } = req.body;

    if (!full_name || !email || !password) {
        return res.status(400).json({ error: 'Please fill all required fields' });
    }

    try {
        const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'User with this email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO users (full_name, email, phone, password_hash, role) 
             VALUES ($1, $2, $3, $4, 'customer') 
             RETURNING id, full_name, email, role`,
            [full_name, email, phone || '', hashedPassword]
        );

        const token = jwt.sign(
            { id: result.rows[0].id, email: result.rows[0].email, role: result.rows[0].role },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.status(201).json({ message: 'User registered successfully', user: result.rows[0], token });
    } catch (error) {
        console.error('Error registering user:', error);
        res.status(500).json({ error: 'Failed to register user' });
    }
});

// 2. LOGIN (POST)
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Please provide email and password' });
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const isValidPassword = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        const token = jwt.sign(
            { id: result.rows[0].id, email: result.rows[0].email, role: result.rows[0].role },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ message: 'Login successful', user: { id: result.rows[0].id, full_name: result.rows[0].full_name, email: result.rows[0].email }, token });
    } catch (error) {
        console.error('Error logging in:', error);
        res.status(500).json({ error: 'Failed to login' });
    }
});

// 3. GET USER PROFILE (GET) - Protected Route
const authenticate = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

app.get('/api/auth/profile', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, full_name, email, phone, created_at FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// ------------ ADVANCED AUTH FEATURES ------------

// 1. FORGET PASSWORD (REQUEST OTP)
app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
        await pool.query('UPDATE users SET reset_otp = $1 WHERE email = $2', [otp, email]);

        // TODO: Send OTP to user's phone via WhatsApp/SMS (Termii/Twilio API)
        res.json({ message: 'OTP sent to your phone', otp }); // For testing, OTP is returned
    } catch (error) {
        res.status(500).json({ error: 'Failed to process request' });
    }
});

// 2. VERIFY OTP & RESET PASSWORD
app.post('/api/auth/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const user = await pool.query('SELECT * FROM users WHERE email = $1 AND reset_otp = $2', [email, otp]);
        if (user.rows.length === 0) return res.status(400).json({ error: 'Invalid OTP' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1, reset_otp = NULL WHERE email = $2', [hashedPassword, email]);
        res.json({ message: 'Password reset successful' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// 3. GOOGLE LOGIN
app.post('/api/auth/google-login', async (req, res) => {
    const { tokenId } = req.body;
    try {
        const ticket = await client.verifyIdToken({ idToken: tokenId, audience: GOOGLE_CLIENT_ID });
        const { email, name, picture } = ticket.getPayload();

        let user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) {
            const newUser = await pool.query(
                `INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, 'customer') RETURNING id, full_name, email, role`,
                [name, email, 'google_oauth_user']
            );
            user = newUser;
        }

        const token = jwt.sign({ id: user.rows[0].id, email: user.rows[0].email, role: user.rows[0].role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ message: 'Google Login successful', user: user.rows[0], token });
    } catch (error) {
        res.status(400).json({ error: 'Invalid Google Token' });
    }
});

// 4. VERIFY PHONE OTP (For SMS/WhatsApp)
app.post('/api/auth/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    try {
        const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        if (user.rows[0].reset_otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });

        await pool.query('UPDATE users SET reset_otp = NULL WHERE email = $1', [email]);
        res.json({ message: 'Phone verified successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to verify OTP' });
    }
});

// ------------ REAL ESTATE API ROUTES ------------

// 1. CREATE A PROPERTY LISTING (POST)
app.post('/api/properties', async (req, res) => {
    try {
        const {
            title, description, address, city, state,
            price_ngn, price_usd, ownership_type, seller_id,
            year_built, land_size_sqm, bedrooms, bathrooms, images
        } = req.body;

        if (!title || !price_ngn || !price_usd || !address) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        if (ownership_type === 'third_party' && !seller_id) {
            return res.status(400).json({ error: 'Third-party properties require a seller_id' });
        }

        const query = `
            INSERT INTO properties (
                title, description, address, city, state,
                price_ngn, price_usd, ownership_type, seller_id,
                year_built, land_size_sqm, bedrooms, bathrooms, images,
                inspection_status, is_certified, engineering_score
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending', FALSE, 0)
            RETURNING *;
        `;

        const values = [
            title, description, address, city, state,
            price_ngn, price_usd, ownership_type, seller_id,
            year_built, land_size_sqm, bedrooms, bathrooms, images || []
        ];

        const result = await pool.query(query, values);

        res.status(201).json({
            message: 'Property listed successfully',
            property: result.rows[0],
            next_step: 'Engineering inspection required. Please upload blueprints and site photos.'
        });

    } catch (error) {
        console.error('Error creating property:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 2. GET ALL PROPERTIES (GET)
app.get('/api/properties', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM properties ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching properties:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 3. GET A SINGLE PROPERTY BY ID (GET)
app.get('/api/properties/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Property not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching property:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ------------ E-COMMERCE API ROUTES ------------

// 1. CREATE A PRODUCT (For Sellers)
app.post('/api/products', async (req, res) => {
    try {
        const { seller_id, category_id, name, description, price_ngn, stock_quantity, main_image } = req.body;
        
        const query = `
            INSERT INTO products (seller_id, category_id, name, description, price_ngn, stock_quantity, main_image)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *;
        `;
        
        const values = [seller_id, category_id, name, description, price_ngn, stock_quantity, main_image];
        const result = await pool.query(query, values);
        
        res.status(201).json({ message: 'Product added successfully', product: result.rows[0] });
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 2. GET ALL PRODUCTS (For Customers)
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, s.store_name, c.name as category_name 
            FROM products p
            LEFT JOIN sellers s ON p.seller_id = s.id
            LEFT JOIN categories c ON p.category_id = c.id
            ORDER BY p.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 3. ADD TO CART (POST) - ULTIMATE FINAL FIX
app.post('/api/cart/add', async (req, res) => {
    const { user_id, product_id, quantity } = req.body;

    try {
        const productCheck = await pool.query('SELECT id FROM products WHERE id = $1', [product_id]);
        if (productCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found. Please check the product ID.' });
        }

        const validUserId = user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : user_id;

        let cartResult = await pool.query('SELECT id FROM cart WHERE user_id = $1', [validUserId]);
        let cart_id;

        if (cartResult.rows.length === 0) {
            const newCart = await pool.query('INSERT INTO cart (user_id) VALUES ($1) RETURNING id', [validUserId]);
            cart_id = newCart.rows[0].id;
        } else {
            cart_id = cartResult.rows[0].id;
        }

        const existingItem = await pool.query(
            'SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2',
            [cart_id, product_id]
        );

        if (existingItem.rows.length > 0) {
            const newQuantity = existingItem.rows[0].quantity + (quantity || 1);
            await pool.query(
                'UPDATE cart_items SET quantity = $1 WHERE id = $2',
                [newQuantity, existingItem.rows[0].id]
            );
        } else {
            await pool.query(
                'INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)',
                [cart_id, product_id, quantity || 1]
            );
        }

        res.status(200).json({ message: 'Item added to cart successfully', cart_id });
    } catch (error) {
        console.error('Error adding to cart:', error);
        res.status(500).json({ error: 'Failed to add item to cart' });
    }
});

// 4. GET CART ITEMS (GET)
app.get('/api/cart/:user_id', async (req, res) => {
    const { user_id } = req.params;

    try {
        const validUserId = user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : user_id;

        const result = await pool.query(`
            SELECT c.id as cart_id, ci.id as item_id, p.id as product_id, 
                   p.name, p.main_image, p.price_ngn, ci.quantity
            FROM cart c
            JOIN cart_items ci ON c.id = ci.cart_id
            JOIN products p ON ci.product_id = p.id
            WHERE c.user_id = $1
        `, [validUserId]);

        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching cart:', error);
        res.status(500).json({ error: 'Failed to fetch cart' });
    }
});

// 5. UPDATE CART ITEM QUANTITY (POST)
app.post('/api/cart/update', async (req, res) => {
    const { item_id, quantity } = req.body;

    try {
        if (quantity <= 0) {
            await pool.query('DELETE FROM cart_items WHERE id = $1', [item_id]);
            return res.json({ message: 'Item removed from cart' });
        }

        await pool.query('UPDATE cart_items SET quantity = $1 WHERE id = $2', [quantity, item_id]);
        res.json({ message: 'Quantity updated successfully' });
    } catch (error) {
        console.error('Error updating cart item:', error);
        res.status(500).json({ error: 'Failed to update cart item' });
    }
});

// 6. REMOVE ITEM FROM CART (DELETE)
app.delete('/api/cart/remove/:item_id', async (req, res) => {
    const { item_id } = req.params;

    try {
        await pool.query('DELETE FROM cart_items WHERE id = $1', [item_id]);
        res.json({ message: 'Item removed from cart successfully' });
    } catch (error) {
        console.error('Error removing cart item:', error);
        res.status(500).json({ error: 'Failed to remove item' });
    }
});

// ------------ ADDRESSES API ------------

// 1. ADD ADDRESS (POST)
app.post('/api/addresses', async (req, res) => {
    const { user_id, full_name, phone, address, city, state, country } = req.body;

    try {
        // Use user_id directly as TEXT (no UUID conversion)
        const result = await pool.query(
            `INSERT INTO addresses (user_id, full_name, phone, address, city, state, country) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [user_id, full_name, phone, address, city, state, country || 'Nigeria']
        );
        res.status(201).json({ message: 'Address added successfully', address: result.rows[0] });
    } catch (error) {
        console.error('Error adding address:', error);
        res.status(500).json({ error: 'Failed to add address' });
    }
});

// 2. GET USER ADDRESSES (GET)
app.get('/api/addresses/:user_id', async (req, res) => {
    const { user_id } = req.params;

    try {
        const result = await pool.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC', [user_id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching addresses:', error);
        res.status(500).json({ error: 'Failed to fetch addresses' });
    }
});

// ------------ WISHLIST API ------------

// 1. ADD TO WISHLIST (POST)
app.post('/api/wishlist/add', async (req, res) => {
    const { user_id, product_id } = req.body;

    try {
        const result = await pool.query(
            'INSERT INTO wishlist (user_id, product_id) VALUES ($1, $2) RETURNING *',
            [user_id, product_id]
        );
        res.status(201).json({ message: 'Added to wishlist', wishlist_item: result.rows[0] });
    } catch (error) {
        // Check if already exists
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Item already in wishlist' });
        }
        console.error('Error adding to wishlist:', error);
        res.status(500).json({ error: 'Failed to add to wishlist' });
    }
});

// 2. GET WISHLIST (GET)
app.get('/api/wishlist/:user_id', async (req, res) => {
    const { user_id } = req.params;

    try {
        const result = await pool.query(`
            SELECT w.id, w.created_at, p.id as product_id, p.name, p.price_ngn, p.main_image
            FROM wishlist w
            JOIN products p ON w.product_id = p.id
            WHERE w.user_id = $1
            ORDER BY w.created_at DESC
        `, [user_id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching wishlist:', error);
        res.status(500).json({ error: 'Failed to fetch wishlist' });
    }
});

// 3. REMOVE FROM WISHLIST (DELETE)
app.delete('/api/wishlist/remove/:wishlist_id', async (req, res) => {
    const { wishlist_id } = req.params;

    try {
        await pool.query('DELETE FROM wishlist WHERE id = $1', [wishlist_id]);
        res.json({ message: 'Removed from wishlist' });
    } catch (error) {
        console.error('Error removing from wishlist:', error);
        res.status(500).json({ error: 'Failed to remove from wishlist' });
    }
});

// ------------ REVIEWS API ------------

// 1. ADD REVIEW (POST)
app.post('/api/reviews', async (req, res) => {
    const { user_id, product_id, rating, comment } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO reviews (user_id, product_id, rating, comment) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [user_id, product_id, rating, comment]
        );
        res.status(201).json({ message: 'Review submitted successfully', review: result.rows[0] });
    } catch (error) {
        console.error('Error adding review:', error);
        res.status(500).json({ error: 'Failed to add review' });
    }
});

// 2. GET PRODUCT REVIEWS (GET)
app.get('/api/reviews/:product_id', async (req, res) => {
    const { product_id } = req.params;

    try {
        const result = await pool.query(`
            SELECT r.*, u.full_name 
            FROM reviews r
            JOIN users u ON r.user_id = u.id
            WHERE r.product_id = $1
            ORDER BY r.created_at DESC
        `, [product_id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching reviews:', error);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

// ------------ SUPPORT TICKETS API ------------

// 1. CREATE SUPPORT TICKET (POST)
app.post('/api/support/tickets', async (req, res) => {
    const { user_id, subject, message } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO support_tickets (user_id, subject, message) 
             VALUES ($1, $2, $3) RETURNING *`,
            [user_id, subject, message]
        );
        res.status(201).json({ message: 'Support ticket created', ticket: result.rows[0] });
    } catch (error) {
        console.error('Error creating ticket:', error);
        res.status(500).json({ error: 'Failed to create ticket' });
    }
});

// 2. GET USER TICKETS (GET)
app.get('/api/support/tickets/:user_id', async (req, res) => {
    const { user_id } = req.params;

    try {
        const result = await pool.query('SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC', [user_id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching tickets:', error);
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
});

// ------------ CHECKOUT & ORDER ROUTES ------------

// 1. CREATE ORDER (POST)
app.post('/api/orders', async (req, res) => {
    const { user_id, total_amount, shipping_address } = req.body;

    try {
        const result = await pool.query(
            'INSERT INTO orders (user_id, total_amount, status, shipping_address) VALUES ($1, $2, $3, $4) RETURNING *',
            [user_id, total_amount, 'pending', shipping_address]
        );
        res.status(201).json({ message: 'Order created successfully', order: result.rows[0] });
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// 2. GET USER ORDERS (GET)
app.get('/api/orders/:user_id', async (req, res) => {
    const { user_id } = req.params;

    try {
        const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [user_id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// ------------ PAYSTACK PAYMENT INTEGRATION ------------

// 1. INITIATE PAYMENT (POST)
app.post('/api/pay/initialize', async (req, res) => {
    const { property_id, buyer_email, amount_ngn, metadata } = req.body;

    const params = JSON.stringify({
        email: buyer_email,
        amount: amount_ngn * 100,
        currency: "NGN",
        metadata: { property_id, ...metadata },
        callback_url: "https://mac-te-engineering.onrender.com/api/pay/verify"
    });

    const options = {
        hostname: 'api.paystack.co',
        port: 443,
        path: '/transaction/initialize',
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
        }
    };

    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
            res.status(200).json(JSON.parse(data));
        });
    }).on('error', (error) => {
        console.error(error);
        res.status(500).json({ error: 'Payment initialization failed' });
    });

    request.write(params);
    request.end();
});

// 2. VERIFY PAYMENT (GET - The callback_url)
app.get('/api/pay/verify', async (req, res) => {
    const reference = req.query.reference;
    if (!reference) {
        return res.status(400).send('Missing reference');
    }

    const options = {
        hostname: 'api.paystack.co',
        port: 443,
        path: `/transaction/verify/${reference}`,
        method: 'GET',
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
    };

    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', async () => {
            const result = JSON.parse(data);
            if (result.data && result.data.status === 'success') {
                try {
                    const { property_id, buyer_id } = result.data.metadata || {};
                    const amount_ngn = result.data.amount / 100;

                    await pool.query(`
                        INSERT INTO transactions 
                        (property_id, buyer_id, amount_ngn, currency_used, payment_method, payment_reference, escrow_status)
                        VALUES ($1, $2, $3, 'NGN', 'card', $4, 'held')
                    `, [property_id, buyer_id, amount_ngn, reference]);

                    res.send(`
                        <html><body style="background:#0f1117; color:white; text-align:center; padding:50px; font-family: Arial, sans-serif;">
                            <h1 style="color:#00d1ff;">✅ Payment Successful!</h1>
                            <p>Your transaction reference: <b>${reference}</b></p>
                            <p>Amount: ₦${amount_ngn.toLocaleString()}</p>
                            <a href="https://mac-te-engineering.onrender.com" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#00d1ff; color:#0f1117; text-decoration:none; border-radius:5px; font-weight:bold;">Return to Home</a>
                        </body></html>
                    `);
                } catch (err) {
                    console.error(err);
                    res.status(500).send('Database error');
                }
            } else {
                res.send(`
                    <html><body style="background:#0f1117; color:white; text-align:center; padding:50px; font-family: Arial, sans-serif;">
                        <h1 style="color:red;">❌ Payment Failed</h1>
                        <p>Reference: ${reference}</p>
                        <a href="https://mac-te-engineering.onrender.com" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#00d1ff; color:#0f1117; text-decoration:none; border-radius:5px; font-weight:bold;">Return to Home</a>
                    </body></html>
                `);
            }
        });
    });

    request.on('error', (error) => { console.error(error); });
    request.end();
});

// ------------ START SERVER ------------
app.listen(PORT, () => {
    console.log(`🚀 Mac-TE Engineering server running on http://localhost:${PORT}`);
});

// Serve the static HTML file for the root URL
app.use(express.static(__dirname));