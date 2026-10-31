const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../config/db');
const authenticateToken = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

router.post('/', authenticateToken, upload.single('proof'), async (req, res) => {
  const { amount, channel, transaction_id, reference } = req.body;
  const proof_image = req.file ? req.file.path : null;

  if (!amount || !channel) return res.status(400).json({ message: 'Amount and payment channel are required.' });

  try {
    await pool.query(
      'INSERT INTO recharges (user_id, amount, channel, transaction_id, reference, proof_image) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, amount, channel, transaction_id || null, reference || null, proof_image]
    );
    res.json({ message: 'Recharge request submitted successfully. Awaiting verification.' });
  } catch (err) {
    res.status(500).json({ message: 'Error processing recharge.', error: err.message });
  }
});

module.exports = router;