require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Storage configuration for Multer (Proof Image Uploads)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Database Connection Pool (Compatible with Railway & Local Environment)
const db = mysql.createPool({
  host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
  user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'skysonsolar',
  port: process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Auto-Initialize MySQL Database Tables on Server Boot
const initDb = async () => {
  try {
    const connection = await db.getConnection();
    console.log("Connected to MySQL Database.");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        invitation_code VARCHAR(50),
        balance DECIMAL(10,2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS recharges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        amount DECIMAL(10,2) NOT NULL,
        channel VARCHAR(50) NOT NULL,
        transaction_id VARCHAR(100),
        reference VARCHAR(50),
        proof_image VARCHAR(255),
        status VARCHAR(20) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS leases (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        plan_name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        daily_income DECIMAL(10,2) NOT NULL,
        duration INT NOT NULL,
        last_claim_time TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    connection.release();
    console.log("Database tables verified and ready!");
  } catch (err) {
    console.error("Database initialization failed:", err.message);
  }
};

initDb();

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ message: 'Access denied. Token missing.' });

  jwt.verify(token, process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026', (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// ==========================================
// API ROUTES
// ==========================================

// Health Check Endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Skysonsolar API is up and running live!' });
});

// 1. User Registration
app.post('/api/auth/register', async (req, res) => {
  const { phone, password, invitation_code } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ message: 'Phone and password are required.' });
  }

  try {
    const [existing] = await db.query('SELECT * FROM users WHERE phone = ?', [phone]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Phone number already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO users (phone, password, invitation_code) VALUES (?, ?, ?)',
      [phone, hashedPassword, invitation_code || null]
    );

    const token = jwt.sign(
      { id: result.insertId, phone },
      process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026',
      { expiresIn: '7d' }
    );

    res.status(201).json({ message: 'User registered successfully!', token, userId: result.insertId });
  } catch (err) {
    res.status(500).json({ message: 'Server error during registration.', error: err.message });
  }
});

// 2. User Login
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ message: 'Phone and password are required.' });
  }

  try {
    const [users] = await db.query('SELECT * FROM users WHERE phone = ?', [phone]);
    if (users.length === 0) {
      return res.status(400).json({ message: 'Invalid phone or password.' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ message: 'Invalid phone or password.' });
    }

    const token = jwt.sign(
      { id: user.id, phone: user.phone },
      process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: { id: user.id, phone: user.phone, balance: user.balance }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error during login.', error: err.message });
  }
});

// 3. Get User Profile & Balance
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const [users] = await db.query('SELECT id, phone, balance, created_at FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found.' });

    res.json({ user: users[0] });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching profile.', error: err.message });
  }
});

// 4. Submit Recharge Request (Supports MTN MoMo, Telecel Cash, USDT TRC20)
app.post('/api/recharge', authenticateToken, upload.single('proof'), async (req, res) => {
  const { amount, channel, transaction_id, reference } = req.body;
  const proof_image = req.file ? req.file.path : null;

  if (!amount || !channel) {
    return res.status(400).json({ message: 'Amount and payment channel are required.' });
  }

  try {
    await db.query(
      'INSERT INTO recharges (user_id, amount, channel, transaction_id, reference, proof_image) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, amount, channel, transaction_id || null, reference || null, proof_image]
    );

    res.json({ message: 'Recharge request submitted successfully. Awaiting verification.' });
  } catch (err) {
    res.status(500).json({ message: 'Error processing recharge.', error: err.message });
  }
});

// 5. Purchase / Lease a Solar Plan (S1 - S8)
app.post('/api/lease/buy', authenticateToken, async (req, res) => {
  const { plan_name, price, daily_income, duration } = req.body;

  if (!plan_name || !price || !daily_income || !duration) {
    return res.status(400).json({ message: 'All plan details are required.' });
  }

  try {
    const [users] = await db.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
    const userBalance = parseFloat(users[0].balance);

    if (userBalance < parseFloat(price)) {
      return res.status(400).json({ message: 'Insufficient balance to purchase this lease.' });
    }

    // Deduct balance & create lease transaction
    await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [price, req.user.id]);
    await db.query(
      'INSERT INTO leases (user_id, plan_name, price, daily_income, duration, last_claim_time) VALUES (?, ?, ?, ?, ?, NOW())',
      [req.user.id, plan_name, price, daily_income, duration]
    );

    res.json({ message: `Successfully leased ${plan_name}! Daily revenue is ready to claim.` });
  } catch (err) {
    res.status(500).json({ message: 'Error completing lease purchase.', error: err.message });
  }
});

// 6. Get User Active Leases
app.get('/api/lease/my-leases', authenticateToken, async (req, res) => {
  try {
    const [leases] = await db.query('SELECT * FROM leases WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ leases });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching active leases.', error: err.message });
  }
});

// 7. Task Center: Claim 24-Hour Daily Revenue
app.post('/api/task/claim', authenticateToken, async (req, res) => {
  const { lease_id } = req.body;

  if (!lease_id) return res.status(400).json({ message: 'Lease ID is required.' });

  try {
    const [leases] = await db.query('SELECT * FROM leases WHERE id = ? AND user_id = ?', [lease_id, req.user.id]);
    if (leases.length === 0) return res.status(404).json({ message: 'Lease plan not found.' });

    const lease = leases[0];
    const now = new Date();
    const lastClaim = lease.last_claim_time ? new Date(lease.last_claim_time) : new Date(lease.created_at);
    const hoursPassed = (now - lastClaim) / (1000 * 60 * 60);

    if (hoursPassed < 24) {
      const hoursRemaining = Math.ceil(24 - hoursPassed);
      return res.status(400).json({ message: `Next claim available in ${hoursRemaining} hour(s).` });
    }

    // Add daily income to user balance and update last claim time
    await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [lease.daily_income, req.user.id]);
    await db.query('UPDATE leases SET last_claim_time = NOW() WHERE id = ?', [lease_id]);

    res.json({ message: `Successfully claimed ${lease.daily_income} daily revenue!`, claimedAmount: lease.daily_income });
  } catch (err) {
    res.status(500).json({ message: 'Error claiming daily revenue.', error: err.message });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});