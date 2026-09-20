const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireOwner, requireStoreUser } = require('../middleware/auth');

const router = express.Router();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function startOfUTCDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n) {
  const d = startOfUTCDay(new Date());
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

async function fetchInvoicesSince(storeId, sinceDate) {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, total, amount_paid, payment_status, created_at')
    .eq('store_id', storeId)
    .gte('created_at', sinceDate.toISOString());
  if (error) throw httpError(500, error.message);
  return data;
}

function summarize(invoices) {
  const revenue = invoices.reduce((sum, i) => sum + Number(i.total), 0);
  const unpaid = invoices.reduce((sum, i) => sum + Math.max(0, Number(i.total) - Number(i.amount_paid ?? 0)), 0);
  const orders = invoices.length;
  const avgOrderValue = orders > 0 ? revenue / orders : 0;
  return { revenue, unpaid, orders, avgOrderValue };
}

router.get('/overview', requireAuth, requireStoreUser, requireOwner, asyncHandler(async (req, res) => {
  const storeId = req.storeId;
  const today = startOfUTCDay(new Date());
  const last7Start = daysAgo(6);
  const last30Start = daysAgo(29);
  const trendStart = daysAgo(13);

  const [todayInvoices, last7Invoices, last30Invoices, trendInvoices] = await Promise.all([
    fetchInvoicesSince(storeId, today),
    fetchInvoicesSince(storeId, last7Start),
    fetchInvoicesSince(storeId, last30Start),
    fetchInvoicesSince(storeId, trendStart)
  ]);

  const trendMap = {};
  for (let i = 13; i >= 0; i -= 1) {
    const key = daysAgo(i).toISOString().slice(0, 10);
    trendMap[key] = 0;
  }
  trendInvoices.forEach((inv) => {
    const key = String(inv.created_at).slice(0, 10);
    if (key in trendMap) trendMap[key] += Number(inv.total);
  });
  const salesTrend = Object.entries(trendMap).map(([date, revenue]) => ({ date, revenue }));

  let topProducts = [];
  const last30Ids = last30Invoices.map((i) => i.id);
  if (last30Ids.length > 0) {
    const { data: items, error: itemsError } = await supabase
      .from('invoice_items')
      .select('product_name, quantity, total, invoice_id')
      .in('invoice_id', last30Ids);
    if (itemsError) throw httpError(500, itemsError.message);

    const byProduct = {};
    (items || []).forEach((item) => {
      if (!byProduct[item.product_name]) {
        byProduct[item.product_name] = { product_name: item.product_name, quantity: 0, revenue: 0 };
      }
      byProduct[item.product_name].quantity += item.quantity;
      byProduct[item.product_name].revenue += Number(item.total);
    });
    topProducts = Object.values(byProduct)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }

  const { data: allProducts, error: productsError } = await supabase
    .from('products')
    .select('id, name, quantity, low_stock_threshold')
    .eq('store_id', storeId)
    .order('quantity', { ascending: true });
  if (productsError) throw httpError(500, productsError.message);
  const lowStockProducts = (allProducts || []).filter((p) => p.quantity <= p.low_stock_threshold);

  res.json({
    today: summarize(todayInvoices),
    last7Days: summarize(last7Invoices),
    last30Days: summarize(last30Invoices),
    salesTrend,
    topProducts,
    lowStockProducts
  });
}));

module.exports = router;
