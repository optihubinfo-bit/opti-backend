// Sends a campaign's pending recipients in the background, after the HTTP
// request that queued it has already returned. Progress is written to the
// database, so the Offers page just polls the campaign row.
//
// Only 'pending' recipients are sent, so resuming after a restart (see
// resumeCampaigns) never re-sends someone who already got the message — except,
// at worst, the few that were in flight at the moment the server stopped.

const supabase = require('../supabaseClient');
const { PROVIDERS } = require('./providers');

const CONCURRENCY = 5;
const running = new Set();

async function sendCampaign(campaignId) {
  if (running.has(campaignId)) return;
  running.add(campaignId);
  try {
    // Claim it: only a queued (or interrupted) campaign moves to sending.
    const { data: campaign } = await supabase
      .from('offer_campaigns')
      .update({ status: 'sending' })
      .eq('id', campaignId)
      .in('status', ['queued', 'sending'])
      .select('id, store_id, channel, message')
      .single();
    if (!campaign) return;

    const provider = PROVIDERS[campaign.channel];
    const { data: store } = await supabase.from('stores').select('name').eq('id', campaign.store_id).single();
    const storeName = store?.name || 'Our store';

    const { data: recipients } = await supabase
      .from('offer_campaign_recipients')
      .select('id, customer_name, phone')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending');

    const queue = [...(recipients || [])];
    async function worker() {
      while (queue.length > 0) {
        const r = queue.shift();
        let update;
        try {
          const { providerMessageId } = await provider.send({
            phone: r.phone,
            customerName: r.customer_name,
            storeName,
            offer: campaign.message
          });
          update = { status: 'sent', provider_message_id: providerMessageId, sent_at: new Date().toISOString(), error: null };
        } catch (err) {
          update = { status: 'failed', error: String(err.message || err).slice(0, 300) };
        }
        await supabase.from('offer_campaign_recipients').update(update).eq('id', r.id);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const [{ count: sent }, { count: failed }] = await Promise.all([
      supabase.from('offer_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'sent'),
      supabase.from('offer_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'failed')
    ]);
    await supabase
      .from('offer_campaigns')
      .update({
        status: (sent || 0) === 0 && (failed || 0) > 0 ? 'failed' : 'sent',
        sent_count: sent || 0,
        failed_count: failed || 0,
        completed_at: new Date().toISOString()
      })
      .eq('id', campaignId);
  } catch (err) {
    console.error('Offer campaign send failed', campaignId, err);
  } finally {
    running.delete(campaignId);
  }
}

// Picks up campaigns that were queued or mid-send when the server last stopped
// (e.g. a Render free-tier restart).
async function resumeCampaigns() {
  const { data, error } = await supabase
    .from('offer_campaigns')
    .select('id')
    .in('status', ['queued', 'sending']);
  if (error) {
    // 011_offer_messages.sql not run yet — nothing to resume.
    if (error.code !== '42P01') console.error('Could not resume offer campaigns', error.message);
    return;
  }
  for (const c of data || []) sendCampaign(c.id);
}

module.exports = { sendCampaign, resumeCampaigns };
