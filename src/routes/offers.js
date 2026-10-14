const express = require('express');
const supabase = require('../supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireOwner, requireStoreUser, requireSuperAdmin } = require('../middleware/auth');
const { PROVIDERS, normalizeIndianMobile, DRY_RUN } = require('../messaging/providers');
const { sendCampaign } = require('../messaging/sender');

const router = express.Router();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const ownerOnly = [requireAuth, requireStoreUser, requireOwner];
const adminOnly = [requireAuth, requireSuperAdmin];

const CHANNELS = ['whatsapp', 'sms'];
// The free demo is capped so one large store can't run up a big bill on it.
const DEMO_MAX_RECIPIENTS = Number(process.env.OFFER_DEMO_MAX_RECIPIENTS) || 50;
// What one message costs the platform (incl. GST) — only used to show the
// super admin an estimate when confirming payment. Update to your real rates.
const COST_PER_MESSAGE = {
  whatsapp: Number(process.env.OFFER_COST_WHATSAPP) || 1.02,
  sms: Number(process.env.OFFER_COST_SMS) || 0.2
};
// DLT SMS template variables are commonly limited to 30 characters each.
// Raise SMS_OFFER_MAX_CHARS only if your registered template allows longer.
const MAX_CHARS = {
  whatsapp: 500,
  sms: Number(process.env.SMS_OFFER_MAX_CHARS) || 30
};
const MAX_AWAITING_PER_STORE = 3;

const CAMPAIGN_FIELDS = 'id, channel, message, is_demo, status, recipient_count, sent_count, failed_count, payment_reference, payment_confirmed_at, created_at, completed_at';

function isMissingTable(error) {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find the table/i.test(error.message || ''));
}
const MIGRATION_HINT = 'Database update needed: run supabase/011_offer_messages.sql in Supabase.';

function cleanMessage(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Opted-in customers with a valid Indian mobile, one entry per number.
async function eligibleRecipients(storeId) {
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone')
    .eq('store_id', storeId)
    .eq('marketing_opt_in', true)
    .not('phone', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw httpError(500, error.code === '42703' ? MIGRATION_HINT : error.message);

  const seen = new Set();
  const result = [];
  for (const c of data || []) {
    const phone = normalizeIndianMobile(c.phone);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    result.push({ customer_id: c.id, customer_name: c.name, phone });
  }
  return result;
}

async function demoUsed(storeId) {
  const { count, error } = await supabase
    .from('offer_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .eq('is_demo', true);
  if (error) throw httpError(500, isMissingTable(error) ? MIGRATION_HINT : error.message);
  return (count || 0) > 0;
}

// ---------- Super admin: confirm payments ----------

router.get('/admin/campaigns', adminOnly, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('offer_campaigns')
    .select(`${CAMPAIGN_FIELDS}, store_id, stores(name)`)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw httpError(500, isMissingTable(error) ? MIGRATION_HINT : error.message);
  res.json({
    costPerMessage: COST_PER_MESSAGE,
    campaigns: (data || []).map((c) => ({
      ...c,
      estimated_cost: Math.round(c.recipient_count * COST_PER_MESSAGE[c.channel] * 100) / 100
    }))
  });
}));

router.post('/admin/campaigns/:id/confirm-payment', adminOnly, asyncHandler(async (req, res) => {
  const reference = cleanMessage(req.body.reference).slice(0, 120);
  if (!reference) throw httpError(400, 'Enter the payment reference (e.g. UPI transaction ID)');

  // Conditional update: a double click can't queue (and pay for) a campaign twice.
  const { data, error } = await supabase
    .from('offer_campaigns')
    .update({
      status: 'queued',
      payment_reference: reference,
      payment_confirmed_by: req.user.id,
      payment_confirmed_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .eq('status', 'awaiting_payment')
    .select(CAMPAIGN_FIELDS)
    .single();
  if (error || !data) throw httpError(409, 'This offer is no longer awaiting payment');

  sendCampaign(data.id);
  res.json(data);
}));

router.post('/admin/campaigns/:id/reject', adminOnly, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('offer_campaigns')
    .update({ status: 'rejected', completed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('status', 'awaiting_payment')
    .select(CAMPAIGN_FIELDS)
    .single();
  if (error || !data) throw httpError(409, 'This offer is no longer awaiting payment');
  res.json(data);
}));

// ---------- Owner ----------

router.get('/status', ownerOnly, asyncHandler(async (req, res) => {
  const [used, recipients] = await Promise.all([demoUsed(req.storeId), eligibleRecipients(req.storeId)]);
  res.json({
    channels: Object.fromEntries(CHANNELS.map((c) => [c, PROVIDERS[c].isConfigured()])),
    dryRun: DRY_RUN,
    maxChars: MAX_CHARS,
    demoAvailable: !used,
    demoMaxRecipients: DEMO_MAX_RECIPIENTS,
    eligibleCount: recipients.length
  });
}));

router.get('/campaigns', ownerOnly, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('offer_campaigns')
    .select(CAMPAIGN_FIELDS)
    .eq('store_id', req.storeId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw httpError(500, isMissingTable(error) ? MIGRATION_HINT : error.message);
  res.json(data);
}));

router.post('/campaigns', ownerOnly, asyncHandler(async (req, res) => {
  const { channel } = req.body;
  if (!CHANNELS.includes(channel)) throw httpError(400, 'Choose WhatsApp or SMS');
  if (!PROVIDERS[channel].isConfigured()) {
    throw httpError(400, `${channel === 'sms' ? 'SMS' : 'WhatsApp'} messages aren't available yet`);
  }
  const message = cleanMessage(req.body.message);
  if (!message) throw httpError(400, 'Enter the offer message');
  if (message.length > MAX_CHARS[channel]) {
    throw httpError(400, `Offer text can be at most ${MAX_CHARS[channel]} characters for ${channel === 'sms' ? 'SMS' : 'WhatsApp'}`);
  }

  const recipients = await eligibleRecipients(req.storeId);
  if (recipients.length === 0) {
    throw httpError(400, 'No customers can receive offers yet. Tick "Agrees to receive offers" on customers who have a mobile number.');
  }

  let isDemo = !(await demoUsed(req.storeId));
  if (!isDemo) {
    const { count } = await supabase
      .from('offer_campaigns')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', req.storeId)
      .eq('status', 'awaiting_payment');
    if ((count || 0) >= MAX_AWAITING_PER_STORE) {
      throw httpError(400, `You already have ${count} offers awaiting payment. Cancel one or wait for it to be confirmed.`);
    }
  }

  async function insertCampaign(demo) {
    const list = demo ? recipients.slice(0, DEMO_MAX_RECIPIENTS) : recipients;
    const result = await supabase
      .from('offer_campaigns')
      .insert({
        store_id: req.storeId,
        channel,
        message,
        is_demo: demo,
        status: demo ? 'queued' : 'awaiting_payment',
        recipient_count: list.length,
        created_by: req.user.id
      })
      .select(CAMPAIGN_FIELDS)
      .single();
    return { ...result, list };
  }

  let { data: campaign, error, list } = await insertCampaign(isDemo);
  if (error && error.code === '23505' && isDemo) {
    // Another request claimed the free demo a moment ago — this one is a paid offer.
    isDemo = false;
    ({ data: campaign, error, list } = await insertCampaign(false));
  }
  if (error) throw httpError(500, isMissingTable(error) ? MIGRATION_HINT : error.message);

  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500).map((r) => ({ ...r, campaign_id: campaign.id }));
    const { error: recipientsError } = await supabase.from('offer_campaign_recipients').insert(chunk);
    if (recipientsError) {
      // Undo, so a failed demo doesn't use up the store's free demo.
      await supabase.from('offer_campaigns').delete().eq('id', campaign.id);
      throw httpError(500, recipientsError.message);
    }
  }

  if (isDemo) sendCampaign(campaign.id);
  res.status(201).json(campaign);
}));

router.post('/campaigns/:id/cancel', ownerOnly, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('offer_campaigns')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('store_id', req.storeId)
    .eq('status', 'awaiting_payment')
    .select(CAMPAIGN_FIELDS)
    .single();
  if (error || !data) throw httpError(409, 'Only an offer that is awaiting payment can be cancelled');
  res.json(data);
}));

module.exports = router;
