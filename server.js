require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');

const app = express();

// ==========================================
// 1. MIDDLEWARE CONFIGURATION
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname))); // Serve frontend files from root

// ==========================================
// 2. DATABASE POOL CONNECTION
// ==========================================
const pool = mysql.createPool({
  host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
  user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'skysonsolar',
  port: process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const upload = multer({ dest: path.join(__dirname, 'uploads') });

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Access token missing or unauthorized.' });

  jwt.verify(token, process.env.JWT_SECRET || 'skyson_secret_key_2026', (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Token is invalid or expired.' });
    req.user = user;
    next();
  });
};

// ==========================================
// 3. AUTHENTICATION ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, invitationCode } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ success: false, message: 'Please provide username, email, and password.' });
  }

  try {
    const [existing] = await pool.query('SELECT user_id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Username or email is already registered.' });
    }

    const [userCountRows] = await pool.query('SELECT COUNT(*) AS totalUsers FROM users');
    const totalUsers = userCountRows[0].totalUsers || 0;
    let ancestorId = null;

    if (totalUsers > 0) {
      if (!invitationCode || invitationCode.trim() === '') {
        return res.status(400).json({ success: false, message: 'An invitation code is required to register.' });
      }
      const trimmedCode = invitationCode.trim();
      const [upline] = await pool.query('SELECT user_id FROM users WHERE referral_code = ?', [trimmedCode]);
      if (upline.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid invitation code.' });
      }
      ancestorId = upline[0].user_id;
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const referralCode = 'SKY' + Math.floor(1000 + Math.random() * 9000);

    const [result] = await pool.query(
      'INSERT INTO users (username, email, password_hash, referral_code, balance, created_at) VALUES (?, ?, ?, ?, 0.00, NOW())',
      [username, email, password_hash, referralCode]
    );

    const newUserId = result.insertId;
    if (ancestorId) {
      await pool.query(
        'INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level, created_at) VALUES (?, ?, 1, NOW())',
        [ancestorId, newUserId]
      ).catch(() => {});
    }

    const token = jwt.sign({ id: newUserId, username }, process.env.JWT_SECRET || 'skyson_secret_key_2026', { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: newUserId, username, email, invitationCode: referralCode } });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Registration failed.', details: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const loginField = username || req.body.email;
  if (!loginField || !password) {
    return res.status(400).json({ success: false, message: 'Please enter username/email and password.' });
  }

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE username = ? OR email = ?', [loginField, loginField]);
    if (users.length === 0) return res.status(400).json({ success: false, message: 'Invalid credentials.' });

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ success: false, message: 'Invalid credentials.' });

    const token = jwt.sign({ id: user.user_id, username: user.username }, process.env.JWT_SECRET || 'skyson_secret_key_2026', { expiresIn: '7d' });
    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.user_id, 
        username: user.username, 
        email: user.email,
        invitationCode: user.referral_code,
        balance: user.balance 
      } 
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

// ==========================================
// 4. FRONTEND FALLBACK ROUTE
// ==========================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});