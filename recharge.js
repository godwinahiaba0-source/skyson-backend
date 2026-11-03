const express = require('express');
const router = express.Router();
const pool = require('./db');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure 'uploads' directory exists locally and on Railway
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage for uploaded payment proofs
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `proof_${Date.now()}_${file.originalname}`);
  }
});
const upload = multer({ storage: storage });

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided.' });

  jwt.verify(token, process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026', (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// Submit regular recharge request (Sky 03 Pay & Zee Pay)
router.post('/submit', verifyToken, async (req, res) => {
  const { amount, channel, transactionId, reference } = req.body;
  
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Valid amount is required.' });
  }

  const finalRef = reference || transactionId || ('REC_' + Date.now());
  const channelName = channel || 'Sky 03 Pay';
  const userId = req.user.id;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Insert into recharges table
    await connection.query(
      `INSERT INTO recharges (user_id, amount, channel, reference, proof_image, status) VALUES (?, ?, ?, ?, NULL, 'pending')`,
      [userId, amount, channelName, finalRef]
    );

    // 2. Insert matching record into transactions table so it appears in history
    await connection.query(
      `INSERT INTO transactions (user_id, type, description, amount, status, created_at) VALUES (?, 'recharge', ?, ?, 'pending', NOW())`,
      [userId, `Account Recharge via ${channelName}`, amount]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Recharge request submitted successfully!' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Recharge submission error:', err);
    res.status(500).json({ success: false, message: 'Server error processing recharge request.' });
  }
});

// Submit recharge request with uploaded screenshot proof (USDT Pay)
router.post('/submit-with-proof', verifyToken, upload.single('proofImage'), async (req, res) => {
  const { amount, channel, transactionId } = req.body;
  const proofImage = req.file ? `/uploads/${req.file.filename}` : null;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Valid amount is required.' });
  }

  const finalRef = transactionId || ('USDT_' + Date.now());
  const channelName = channel || 'USDT Pay';
  const userId = req.user.id;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Insert into recharges table
    await connection.query(
      `INSERT INTO recharges (user_id, amount, channel, reference, proof_image, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
      [userId, amount, channelName, finalRef, proofImage]
    );

    // 2. Insert matching record into transactions table so it appears in history
    await connection.query(
      `INSERT INTO transactions (user_id, type, description, amount, status, created_at) VALUES (?, 'recharge', ?, ?, 'pending', NOW())`,
      [userId, `Account Recharge via ${channelName}`, amount]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'USDT deposit proof submitted successfully!' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('USDT recharge submission error:', err);
    res.status(500).json({ success: false, message: 'Server error processing payment proof.' });
  }
});

module.exports = router;