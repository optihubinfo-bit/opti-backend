// Bulk offer message providers.
//
// Both WhatsApp marketing messages and Indian SMS must use a template that was
// registered in advance (Meta template approval / DLT). Owners only supply the
// offer text, which fills one variable in that template:
//
//   WhatsApp template body:  Hi {{1}}, {{2}} has a special offer for you: {{3}}
//   SMS (MSG91 / DLT):        Dear ##name##, ##store## offer: ##offer##
//
// The exact wording is whatever you registered; only the variable order/names
// must match. See README "Offer messages" for setup.
//
// MESSAGING_DRY_RUN=true logs messages instead of sending them (for testing).

const DRY_RUN = process.env.MESSAGING_DRY_RUN === 'true';

const whatsapp = {
  id: 'whatsapp',
  isConfigured() {
    return DRY_RUN || !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_TEMPLATE_NAME);
  },
  // Meta rejects template parameters containing newlines, tabs or 4+ spaces in a row.
  cleanParam(text) {
    return String(text).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  },
  async send({ phone, customerName, storeName, offer }) {
    if (DRY_RUN) return dryRun('whatsapp', phone, `Hi ${customerName}, ${storeName} has a special offer for you: ${offer}`);

    const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
    const res = await fetch(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: process.env.WHATSAPP_TEMPLATE_NAME,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{
            type: 'body',
            parameters: [customerName, storeName, offer].map((t) => ({ type: 'text', text: this.cleanParam(t) }))
          }]
        }
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `WhatsApp API error ${res.status}`);
    return { providerMessageId: body?.messages?.[0]?.id || null };
  }
};

const sms = {
  id: 'sms',
  isConfigured() {
    return DRY_RUN || !!(process.env.MSG91_AUTH_KEY && process.env.MSG91_SMS_TEMPLATE_ID);
  },
  async send({ phone, customerName, storeName, offer }) {
    if (DRY_RUN) return dryRun('sms', phone, `Dear ${customerName}, ${storeName} offer: ${offer}`);

    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: {
        authkey: process.env.MSG91_AUTH_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        template_id: process.env.MSG91_SMS_TEMPLATE_ID,
        short_url: '0',
        // DLT variables are commonly capped at 30 characters each.
        recipients: [{ mobiles: phone, name: clip(customerName, 30), store: clip(storeName, 30), offer }]
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.type === 'error') throw new Error(body?.message || `MSG91 error ${res.status}`);
    return { providerMessageId: body?.request_id || body?.message || null };
  }
};

function clip(text, max) {
  return String(text).slice(0, max);
}

function dryRun(channel, phone, text) {
  console.log(`[messaging dry run] ${channel} -> ${phone}: ${text}`);
  return { providerMessageId: `dry-run-${Date.now()}` };
}

const PROVIDERS = { whatsapp, sms };

// Indian mobile numbers only (that's what DLT SMS and these rates cover):
// returns "91XXXXXXXXXX", or null if the number isn't a valid Indian mobile.
function normalizeIndianMobile(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length !== 10 || !/^[6-9]/.test(digits)) return null;
  return `91${digits}`;
}

module.exports = { PROVIDERS, normalizeIndianMobile, DRY_RUN };
