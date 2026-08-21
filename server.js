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
    ssl: { rejectUnauthorized: false }
});

// Test database connection
pool.connect((err) => {
    if (err) console.error('Database connection failed:', err);
    else console.log('✅ Connected to PostgreSQL database');
});

// AUTO-CREATE CART TABLES
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
        console.log('✅ Cart tables ensured');
    } catch (err) { console.error('Error creating cart tables:', err); }
};
createCartTables();

// AUTO-CREATE USERS TABLE
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
        const colCheck = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='reset_otp'`);
        if (colCheck.rows.length === 0) {
            await pool.query(`ALTER TABLE users ADD COLUMN reset_otp VARCHAR(10)`);
            console.log('✅ Added reset_otp');
        }
        const passCheck = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='password_hash'`);
        if (passCheck.rows.length === 0) {
            await pool.query(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NOT NULL DEFAULT 'temp_password'`);
            console.log('✅ Added password_hash');
        }
    } catch (err) { console.error('Error creating users table:', err); }
};
createUsersTable();

// ------------ AUTH ------------
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-123';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'your-google-client-id.apps.googleusercontent.com';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

app.post('/api/auth/register', async (req, res) => {
    const { full_name, email, phone, password } = req.body;
    if (!full_name || !email || !password) return res.status(400).json({ error: 'Please fill all required fields' });
    try {
        const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) return res.status(400).json({ error: 'User already exists' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (full_name, email, phone, password_hash, role) VALUES ($1, $2, $3, $4, 'customer') RETURNING id, full_name, email, role`,
            [full_name, email, phone || '', hashedPassword]
        );
        const token = jwt.sign({ id: result.rows[0].id, email: result.rows[0].email, role: result.rows[0].role }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ message: 'User registered', user: result.rows[0], token });
    } catch (error) { console.error(error); res.status(500).json({ error: 'Failed to register' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Provide email and password' });
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const isValid = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!isValid) return res.status(401).json({ error: 'Invalid password' });
        const token = jwt.sign({ id: result.rows[0].id, email: result.rows[0].email, role: result.rows[0].role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ message: 'Login successful', user: { id: result.rows[0].id, full_name: result.rows[0].full_name, email: result.rows[0].email }, token });
    } catch (error) { console.error(error); res.status(500).json({ error: 'Failed to login' }); }
});

// Forgot Password (OTP)
app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await pool.query('UPDATE users SET reset_otp = $1 WHERE email = $2', [otp, email]);
        res.json({ message: 'OTP sent', otp });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const user = await pool.query('SELECT * FROM users WHERE email = $1 AND reset_otp = $2', [email, otp]);
        if (user.rows.length === 0) return res.status(400).json({ error: 'Invalid OTP' });
        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1, reset_otp = NULL WHERE email = $2', [hashed, email]);
        res.json({ message: 'Password reset successful' });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/auth/google-login', async (req, res) => {
    const { tokenId } = req.body;
    try {
        const ticket = await client.verifyIdToken({ idToken: tokenId, audience: GOOGLE_CLIENT_ID });
        const { email, name } = ticket.getPayload();
        let user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) {
            const newUser = await pool.query(`INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, 'customer') RETURNING id, full_name, email, role`, [name, email, 'google_oauth_user']);
            user = newUser;
        }
        const token = jwt.sign({ id: user.rows[0].id, email: user.rows[0].email, role: user.rows[0].role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ message: 'Google Login successful', user: user.rows[0], token });
    } catch (error) { res.status(400).json({ error: 'Invalid Google Token' }); }
});

// ------------ SHOP ------------
app.post('/api/products', async (req, res) => {
    const { seller_id, category_id, name, description, price_ngn, stock_quantity, main_image } = req.body;
    try {
        const result = await pool.query(`INSERT INTO products (seller_id, category_id, name, description, price_ngn, stock_quantity, main_image) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [seller_id, category_id, name, description, price_ngn, stock_quantity, main_image]);
        res.status(201).json({ message: 'Product added', product: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed to add product' }); }
});

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(`SELECT p.*, s.store_name, c.name as category_name FROM products p LEFT JOIN sellers s ON p.seller_id = s.id LEFT JOIN categories c ON p.category_id = c.id ORDER BY p.created_at DESC`);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch products' }); }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ message: 'Product deleted' });
    } catch (error) { res.status(500).json({ error: 'Failed to delete' }); }
});

// ------------ CART ------------
app.post('/api/cart/add', async (req, res) => {
    const { user_id, product_id, quantity } = req.body;
    try {
        const productCheck = await pool.query('SELECT id FROM products WHERE id = $1', [product_id]);
        if (productCheck.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
        const validUserId = user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : user_id;
        let cartResult = await pool.query('SELECT id FROM cart WHERE user_id = $1', [validUserId]);
        let cart_id;
        if (cartResult.rows.length === 0) {
            const newCart = await pool.query('INSERT INTO cart (user_id) VALUES ($1) RETURNING id', [validUserId]);
            cart_id = newCart.rows[0].id;
        } else cart_id = cartResult.rows[0].id;
        const existing = await pool.query('SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2', [cart_id, product_id]);
        if (existing.rows.length > 0) {
            await pool.query('UPDATE cart_items SET quantity = $1 WHERE id = $2', [existing.rows[0].quantity + (quantity || 1), existing.rows[0].id]);
        } else {
            await pool.query('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)', [cart_id, product_id, quantity || 1]);
        }
        res.status(200).json({ message: 'Item added to cart', cart_id });
    } catch (error) { console.error(error); res.status(500).json({ error: 'Failed to add to cart' }); }
});

app.get('/api/cart/:user_id', async (req, res) => {
    try {
        const validUserId = req.params.user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : req.params.user_id;
        const result = await pool.query(`SELECT c.id as cart_id, ci.id as item_id, p.id as product_id, p.name, p.main_image, p.price_ngn, ci.quantity FROM cart c JOIN cart_items ci ON c.id = ci.cart_id JOIN products p ON ci.product_id = p.id WHERE c.user_id = $1`, [validUserId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch cart' }); }
});

app.post('/api/cart/update', async (req, res) => {
    const { item_id, quantity } = req.body;
    try {
        if (quantity <= 0) await pool.query('DELETE FROM cart_items WHERE id = $1', [item_id]);
        else await pool.query('UPDATE cart_items SET quantity = $1 WHERE id = $2', [quantity, item_id]);
        res.json({ message: 'Cart updated' });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/cart/remove/:item_id', async (req, res) => {
    try {
        await pool.query('DELETE FROM cart_items WHERE id = $1', [req.params.item_id]);
        res.json({ message: 'Item removed' });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// ------------ WISHLIST ------------
app.post('/api/wishlist/add', async (req, res) => {
    const { user_id, product_id } = req.body;
    try {
        const validUserId = user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : user_id;
        const result = await pool.query('INSERT INTO wishlist (user_id, product_id) VALUES ($1, $2) RETURNING *', [validUserId, product_id]);
        res.status(201).json({ message: 'Added to wishlist', wishlist_item: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'Already in wishlist' });
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/wishlist/:user_id', async (req, res) => {
    try {
        const validUserId = req.params.user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : req.params.user_id;
        const result = await pool.query(`SELECT w.id, w.created_at, p.id as product_id, p.name, p.price_ngn, p.main_image FROM wishlist w JOIN products p ON w.product_id = p.id WHERE w.user_id = $1 ORDER BY w.created_at DESC`, [validUserId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/wishlist/remove/:wishlist_id', async (req, res) => {
    try {
        await pool.query('DELETE FROM wishlist WHERE id = $1', [req.params.wishlist_id]);
        res.json({ message: 'Removed from wishlist' });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// ------------ REVIEWS ------------
app.post('/api/reviews', async (req, res) => {
    const { user_id, product_id, rating, comment } = req.body;
    try {
        const validUserId = user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : user_id;
        const result = await pool.query(`INSERT INTO reviews (user_id, product_id, rating, comment) VALUES ($1, $2, $3, $4) RETURNING *`, [validUserId, product_id, rating, comment]);
        res.status(201).json({ message: 'Review submitted', review: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/reviews/:product_id', async (req, res) => {
    try {
        const result = await pool.query(`SELECT r.*, u.full_name FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.product_id = $1 ORDER BY r.created_at DESC`, [req.params.product_id]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// ------------ ADDRESSES ------------
app.post('/api/addresses', async (req, res) => {
    const { user_id, full_name, phone, address, city, state, is_default } = req.body;
    try {
        const validUserId = user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : user_id;
        const result = await pool.query(`INSERT INTO addresses (user_id, full_name, phone, address, city, state, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [validUserId, full_name, phone, address, city, state, is_default || false]);
        res.status(201).json({ message: 'Address added', address: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/addresses/:user_id', async (req, res) => {
    try {
        const validUserId = req.params.user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : req.params.user_id;
        const result = await pool.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC', [validUserId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// ------------ SUPPORT TICKETS ------------
app.post('/api/support/tickets', async (req, res) => {
    const { user_id, subject, message } = req.body;
    try {
        const validUserId = user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : user_id;
        const result = await pool.query(`INSERT INTO support_tickets (user_id, subject, message) VALUES ($1, $2, $3) RETURNING *`, [validUserId, subject, message]);
        res.status(201).json({ message: 'Ticket created', ticket: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/support/tickets/:user_id', async (req, res) => {
    try {
        const validUserId = req.params.user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : req.params.user_id;
        const result = await pool.query('SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC', [validUserId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// ------------ ORDERS ------------
app.post('/api/orders', async (req, res) => {
    const { user_id, total_amount, shipping_address } = req.body;
    try {
        const validUserId = user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : user_id;
        const result = await pool.query(`INSERT INTO orders (user_id, total_amount, status, shipping_address) VALUES ($1, $2, $3, $4) RETURNING *`, [validUserId, total_amount, 'pending', shipping_address]);
        res.status(201).json({ message: 'Order created', order: result.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/orders/:user_id', async (req, res) => {
    try {
        const validUserId = req.params.user_id === "test-user-123" ? "00000000-0000-0000-0000-000000000001" : req.params.user_id;
        const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [validUserId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/orders/details/:order_id', async (req, res) => {
    try {
        const result = await pool.query(`SELECT o.id, o.total_amount, o.status, o.created_at, o.shipping_address, oi.quantity, oi.price_at_purchase, p.name, p.main_image FROM orders o JOIN order_items oi ON o.id = oi.order_id JOIN products p ON oi.product_id = p.id WHERE o.id = $1`, [req.params.order_id]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// ------------ PAYSTACK ------------
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
        hostname: 'api.paystack.co', port: 443, path: '/transaction/initialize', method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
    };
    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => res.status(200).json(JSON.parse(data)));
    }).on('error', (error) => { console.error(error); res.status(500).json({ error: 'Payment failed' }); });
    request.write(params);
    request.end();
});

app.get('/api/pay/verify', async (req, res) => {
    const reference = req.query.reference;
    if (!reference) return res.status(400).send('Missing reference');
    const options = {
        hostname: 'api.paystack.co', port: 443, path: `/transaction/verify/${reference}`, method: 'GET',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
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
                    await pool.query(`INSERT INTO transactions (property_id, buyer_id, amount_ngn, currency_used, payment_method, payment_reference, escrow_status) VALUES ($1, $2, $3, 'NGN', 'card', $4, 'held')`, [property_id, buyer_id, amount_ngn, reference]);
                    res.send(`<html><body style="background:#0f1117; color:white; text-align:center; padding:50px; font-family: Arial, sans-serif;"><h1 style="color:#00d1ff;">✅ Payment Successful!</h1><p>Reference: ${reference}</p><p>Amount: ₦${amount_ngn.toLocaleString()}</p><a href="https://mac-te-engineering.onrender.com" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#00d1ff; color:#0f1117; text-decoration:none; border-radius:5px; font-weight:bold;">Return to Home</a></body></html>`);
                } catch (err) { console.error(err); res.status(500).send('Database error'); }
            } else {
                res.send(`<html><body style="background:#0f1117; color:white; text-align:center; padding:50px; font-family: Arial, sans-serif;"><h1 style="color:red;">❌ Payment Failed</h1><p>Reference: ${reference}</p><a href="https://mac-te-engineering.onrender.com" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#00d1ff; color:#0f1117; text-decoration:none; border-radius:5px; font-weight:bold;">Return to Home</a></body></html>`);
            }
        });
    });
    request.on('error', (error) => { console.error(error); });
    request.end();
});

// ------------ START SERVER ------------
app.listen(PORT, () => console.log(`🚀 Mac-TE Engineering server running on http://localhost:${PORT}`));
app.use(express.static(__dirname));