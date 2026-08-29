require('dotenv').config();
const express = require('express');
const cors = require('cors');

const productsRouter = require('./routes/products');
const customersRouter = require('./routes/customers');
const invoicesRouter = require('./routes/invoices');
const authRouter = require('./routes/auth');
const reportsRouter = require('./routes/reports');
const usersRouter = require('./routes/users');
const storesRouter = require('./routes/stores');
const storeRouter = require('./routes/store');
const errorHandler = require('./middleware/errorHandler');
const { requireAuth } = require('./middleware/auth');

const app = express();

const allowedOrigins = [process.env.FRONTEND_URL, 'http://localhost:5173'].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser requests (no origin header) and any explicitly configured origin.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/stores', storesRouter);
app.use('/api/store', storeRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/customers', requireAuth, customersRouter);
app.use('/api/invoices', requireAuth, invoicesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/users', usersRouter);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
