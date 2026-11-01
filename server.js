require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ==========================================
// 1. BULLETPROOF CORS & MIDDLEWARE (Must be first)
// ==========================================
const allowedOrigins = [
  'https://skyson-front-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname)));

// ==========================================
// 2. IMPORT ROUTES (Make sure paths match your folder)
// ==========================================
const authRoutes = require('./auth');
const userRoutes = require('./user');
const leaseRoutes = require('./lease');
const rechargeRoutes = require('./recharge');
const walletRoutes = require('./wallet'); 
const teamRoutes = require('./team'); // Team report routes
const adminRoutes = require('./admin'); // Admin panel routes

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/lease', leaseRoutes);
app.use('/api/recharge', rechargeRoutes);
app.use('/api/bankcard', walletRoutes);
app.use('/api', teamRoutes); // Mounts /api/team/report
app.use('/api/admin', adminRoutes); // Mounts admin panel endpoints

// ==========================================
// 3. SERVER STARTUP
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Skysonsolar backend running on port ${PORT}`);
});