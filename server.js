require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Import Database connection (auto-initializes tables)
require('./config/db');

// Import Route modules with correct relative paths
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const rechargeRoutes = require('./routes/recharge');
const leaseRoutes = require('./routes/lease');
const taskRoutes = require('./routes/task');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/recharge', rechargeRoutes);
app.use('/api/lease', leaseRoutes);
app.use('/api/task', taskRoutes);

// Health Check
app.get('/', (req, res) => {
  res.json({ message: 'Skysonsolar modular API is up and running live!' });
});

// Start Server (Bound to 0.0.0.0 and Railway's dynamic PORT)
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});