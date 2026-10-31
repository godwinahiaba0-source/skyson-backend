require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MySQL Database Pool Connection
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

// Multer Setup for Uploads
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token missing or unauthorized.' });

  jwt.verify(token, process.env.JWT_SECRET || 'skyson_secret_key_2026', (err, user) => {
    if (err) return res.status(403).json({ error: 'Token is invalid or expired.' });
    req.user = user;
    next();
  });
};

/* ==================== AUTH ROUTES ==================== */

// Register User
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, invitationCode } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Please provide all required fields.' });
  }

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE phone = ?', [username]);
    if (existing.length > 0) return res.status(400).json({ error: 'Username or phone already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (phone, password, invitation_code, balance) VALUES (?, ?, ?, ?)',
      [username, hashedPassword, invitationCode || 'SKY7291', 0.00]
    );

    const token = jwt.sign({ id: result.insertId, username }, process.env.JWT_SECRET || 'skyson_secret_key_2026', { expiresIn: '7d' });
    res.json({ token, user: { id: result.insertId, username, invitationCode: invitationCode || 'SKY7291' } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed.', details: err.message });
  }
});

// Login User
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Please enter username and password.' });
  }

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE phone = ?', [username]);
    if (users.length === 0) return res.status(400).json({ error: 'Invalid username or password.' });

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid username or password.' });

    const token = jwt.sign({ id: user.id, username: user.phone }, process.env.JWT_SECRET || 'skyson_secret_key_2026', { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.phone, invitationCode: user.invitation_code } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed.', details: err.message });
  }
});

// Update Login Password
app.post('/api/auth/update-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, users[0].password);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);
    res.json({ message: 'Login password updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password.', details: err.message });
  }
});

// Update Fund Password
app.post('/api/auth/update-fund-password', authenticateToken, async (req, res) => {
  const { currentPassword, newFundPassword } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, users[0].password);
    if (!valid) return res.status(400).json({ error: 'Current login password incorrect.' });

    const hashedFund = await bcrypt.hash(newFundPassword, 10);
    await pool.query('UPDATE users SET fund_password = ? WHERE id = ?', [hashedFund, req.user.id]);
    res.json({ message: 'Fund password updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update fund password.', details: err.message });
  }
});


/* ==================== USER & DASHBOARD ROUTES ==================== */

// Get Dashboard Summary
app.get('/api/user/dashboard', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
    const [leases] = await pool.query('SELECT SUM(daily_income) as total_earnings, SUM(price) as total_deposit FROM leases WHERE user_id = ?', [req.user.id]);

    res.json({
      balance: parseFloat(users[0].balance || 0),
      todayEarnings: parseFloat(leases[0].total_earnings || 0),
      yesterdayEarnings: parseFloat(leases[0].total_earnings || 0),
      totalDeposit: parseFloat(leases[0].total_deposit || 0)
    });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching dashboard data.' });
  }
});

// Get Profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, phone, invitation_code, created_at FROM users WHERE id = ?', [req.user.id]);
    res.json({
      username: users[0].phone,
      uid: 10000 + users[0].id,
      phone: users[0].phone,
      email: `${users[0].phone}@skyson.com`,
      createdAt: users[0].created_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching profile.' });
  }
});

app.post('/api/user/profile', authenticateToken, async (req, res) => {
  res.json({ message: 'Profile updated successfully!' });
});

// Bank Card Binding
app.get('/api/bankcard', authenticateToken, async (req, res) => {
  try {
    const [cards] = await pool.query('SELECT * FROM bank_cards WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
    res.json({ card: cards[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching bank card.' });
  }
});

app.post('/api/bankcard', authenticateToken, async (req, res) => {
  const { channel, official_name, account_number } = req.body;
  try {
    await pool.query('INSERT INTO bank_cards (user_id, channel, official_name, account_number) VALUES (?, ?, ?, ?)',
      [req.user.id, channel, official_name, account_number]
    );
    res.json({ message: 'Withdrawal account bound successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to bind account.' });
  }
});

// Withdrawal Request
app.post('/api/user/withdraw', authenticateToken, async (req, res) => {
  const { amount, channel, accountNumber } = req.body;
  if (!amount || amount < 50) return res.status(400).json({ error: 'Minimum withdrawal is GH₵ 50.00' });

  try {
    const [users] = await pool.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
    if (users[0].balance < amount) return res.status(400).json({ error: 'Insufficient balance.' });

    const fee = amount * 0.10;
    const netAmount = amount - fee;

    await pool.query('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, req.user.id]);
    await pool.query('INSERT INTO withdrawals (user_id, amount, fee, net_amount, channel, account_number, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, amount, fee, netAmount, channel, accountNumber, 'Pending']
    );
    await pool.query('INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'withdraw', 'Withdrawal Request', -amount, 'Pending']
    );

    res.json({ message: 'Withdrawal request submitted successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Withdrawal failed.' });
  }
});

// Transaction History
app.get('/api/user/transactions', authenticateToken, async (req, res) => {
  try {
    const [records] = await pool.query('SELECT type, description, amount, status, created_at as date FROM transactions WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching transactions.' });
  }
});


/* ==================== RECHARGE ROUTES ==================== */

app.post('/api/recharge/submit', authenticateToken, async (req, res) => {
  const { amount, channel, transactionId, reference } = req.body;
  try {
    await pool.query('INSERT INTO recharges (user_id, amount, channel, transaction_id, reference, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, amount, channel, transactionId, reference, 'Pending']
    );
    await pool.query('INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'recharge', `${channel} Deposit`, amount, 'Pending']
    );
    res.json({ message: 'Recharge request submitted successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Recharge failed.' });
  }
});

app.post('/api/recharge/submit-with-proof', authenticateToken, upload.single('proofImage'), async (req, res) => {
  const { amount, channel, transactionId } = req.body;
  const proofImage = req.file ? req.file.filename : null;
  try {
    await pool.query('INSERT INTO recharges (user_id, amount, channel, transaction_id, proof_image, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, amount, channel, transactionId, proofImage, 'Pending']
    );
    await pool.query('INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'recharge', `${channel} Deposit`, amount, 'Pending']
    );
    res.json({ message: 'Deposit with proof submitted successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Deposit failed.' });
  }
});


/* ==================== LEASE ROUTES ==================== */

app.get('/api/lease/my-leases', authenticateToken, async (req, res) => {
  try {
    const [leases] = await pool.query('SELECT * FROM leases WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json(leases);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching leases.' });
  }
});

app.post('/api/lease/create', authenticateToken, async (req, res) => {
  const { planName, price, dailyIncome, duration } = req.body;
  try {
    const [users] = await pool.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
    if (users[0].balance < price) return res.status(400).json({ message: 'Insufficient balance to lease plan.' });

    await pool.query('UPDATE users SET balance = balance - ? WHERE id = ?', [price, req.user.id]);
    await pool.query('INSERT INTO leases (user_id, plan_name, price, daily_income, duration) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, planName, price, dailyIncome, duration]
    );
    await pool.query('INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'lease', `Leased ${planName}`, -price, 'Success']
    );

    res.json({ message: `Successfully leased ${planName}!` });
  } catch (err) {
    res.status(500).json({ error: 'Lease creation failed.' });
  }
});

app.post('/api/lease/claim', authenticateToken, async (req, res) => {
  const { leaseId, amount } = req.body;
  try {
    await pool.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, req.user.id]);
    await pool.query('UPDATE leases SET last_claim_time = CURRENT_TIMESTAMP WHERE id = ?', [leaseId]);
    await pool.query('INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'earnings', 'Daily Lease Revenue Claim', amount, 'Success']
    );
    res.json({ message: 'Claim successful!' });
  } catch (err) {
    res.status(500).json({ error: 'Claim failed.' });
  }
});


/* ==================== BONUS, TEAM & FUND ROUTES ==================== */

app.post('/api/bonus/claim', authenticateToken, async (req, res) => {
  const { code } = req.body;
  if (code === 'CI5RWF' || code === 'BONUS20') {
    const amount = code === 'BONUS20' ? 20.00 : 50.00;
    await pool.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, req.user.id]);
    await pool.query('INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'earnings', `Bonus Code ${code}`, amount, 'Success']
    );
    return res.json({ amount });
  }
  res.status(400).json({ error: 'Invalid or expired bonus code.' });
});

app.get('/api/bonus/history', authenticateToken, async (req, res) => {
  res.json({ claims: [] });
});

app.get('/api/team/report', authenticateToken, async (req, res) => {
  try {
    const [downlines] = await pool.query('SELECT phone as username, CONCAT(phone, "@skyson.com") as email, created_at FROM users WHERE id != ?', [req.user.id]);
    res.json({ teamRecharge: 0, firstCharges: 0, teamSize: downlines.length, teamWithdraw: 0, firstPush: 0, newTeam: 0, downlines });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching team report.' });
  }
});

app.get('/api/fund/summary', authenticateToken, async (req, res) => {
  res.json({ totalActive: 0, todayEarnings: 0 });
});

app.post('/api/fund/invest', authenticateToken, async (req, res) => {
  res.json({ message: 'Investment successful!' });
});

// Root check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Skysonsolar single-file API is live!' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});